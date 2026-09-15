import express from 'express'
import { classDb } from '../db/index.js'
import { logClassStart, logClassCreated, logStudentsAdded, logClassDone, logClassFailed } from '../logging/classLogger.js'

const router = express.Router()

const CLASS_NAME_MAX   = 100
const STUDENT_NAME_MAX = 100

// Accepts "10e", "Year 10", "Year 10 Set 3 English" — uses the explicit "year N"
// form first, falls back to a leading digit run.
function parseYear(className) {
    const m = className.match(/year\s*(\d+)/i) ?? className.match(/^(\d+)/)
    return m ? parseInt(m[1], 10) : null
}

// GET /classes — all classes belonging to the logged-in teacher, with student count
router.get('/', async (req, res, next) => {
    try {
        res.json(await classDb.listClasses(req.user.id))
    } catch (err) {
        next(err)
    }
})

// GET /classes/:id/students — all students in a class owned by this teacher
router.get('/:id/students', async (req, res, next) => {
    try {
        const cls = await classDb.findClassById(req.params.id, req.user.id)
        if (!cls) return res.status(404).json({ error: 'Class not found' })
        res.json(await classDb.listStudents(cls.id))
    } catch (err) {
        next(err)
    }
})

// POST /classes
router.post('/', async (req, res, next) => {
    try {
        const { className, students } = req.body
        const teacherId = req.user.id

        logClassStart(req)

        if (!className?.trim()) {
            logClassFailed(req, 'validation', 'Class name is required')
            return res.status(400).json({ error: 'Class name is required' })
        }
        if (className.trim().length > CLASS_NAME_MAX) {
            logClassFailed(req, 'validation', 'Class name too long')
            return res.status(400).json({ error: `Class name must not exceed ${CLASS_NAME_MAX} characters` })
        }
        if (!Array.isArray(students) || students.length === 0) {
            logClassFailed(req, 'validation', 'At least one student is required')
            return res.status(400).json({ error: 'At least one student is required' })
        }

        const oversized = students.map(n => n.trim()).filter(n => n.length > STUDENT_NAME_MAX)
        if (oversized.length) {
            logClassFailed(req, 'validation', `Student name(s) too long: ${oversized.join(', ')}`)
            return res.status(400).json({ error: `Student names must not exceed ${STUDENT_NAME_MAX} characters` })
        }

        const yearGroupId = parseYear(className.trim())
        const validYear   = yearGroupId ? await classDb.validateYear(yearGroupId) : null
        if (!validYear) {
            logClassFailed(req, 'validation', `Invalid year parsed from class name: ${className}`)
            return res.status(400).json({ error: 'Class name must include a valid year (7–11), e.g. "Year 10 Set 3" or "10e"' })
        }

        const result = await classDb.transaction(async (client) => {
            const existing = await classDb.findClassByName(className.trim(), teacherId, client)

            let classId, isNew
            if (existing) {
                classId = existing.id
                isNew   = false
            } else {
                const { id } = await classDb.insertClass(className.trim(), yearGroupId, teacherId, client)
                classId = id
                isNew   = true
                logClassCreated(req, className.trim(), yearGroupId)
            }

            // Async: can't use .filter with await, so collect conflicts in a loop.
            const conflicts = []
            for (const raw of students) {
                const name = raw.trim()
                if (await classDb.findStudentByName(name, classId, client)) conflicts.push(name)
            }

            if (conflicts.length) return { conflict: true, conflicts }

            const added = []
            for (const raw of students) {
                const trimmed = raw.trim()
                const { id: studentId } = await classDb.insertStudent(trimmed, classId, client)
                added.push({ id: studentId, student_name: trimmed })
            }

            logStudentsAdded(req, added.map(s => s.student_name))
            logClassDone(req, classId, added.length)

            return { conflict: false, classId, isNew, yearGroupId, added }
        })

        if (result.conflict) {
            const names = result.conflicts.join(', ')
            logClassFailed(req, 'duplicate_students', `Conflicts: ${names}`)
            return res.status(409).json({
                error:     `The following name${result.conflicts.length === 1 ? '' : 's'} already exist in this class: ${names}. Please add a unique identifier (e.g. "Andy S" or "Andy 2").`,
                conflicts: result.conflicts,
            })
        }

        res.status(result.isNew ? 201 : 200).json({
            id:             result.classId,
            class_name:     className.trim(),
            year_group_id:  result.yearGroupId,
            is_new:         result.isNew,
            students_added: result.added,
        })
    } catch (err) {
        logClassFailed(req, 'server_error', err.message)
        next(err)
    }
})

// Helper: load a class only if it belongs to the logged-in teacher.
// Returns a Promise (callers await).
function ownedClass(classId, teacherId) {
    return classDb.findClassById(classId, teacherId)
}

// PATCH /classes/:id — rename a class (and re-derive year if it changes).
router.patch('/:id', async (req, res, next) => {
    try {
        const { class_name: newName } = req.body
        if (!newName?.trim()) {
            return res.status(400).json({ error: 'Class name is required' })
        }
        if (newName.trim().length > CLASS_NAME_MAX) {
            return res.status(400).json({ error: `Class name must not exceed ${CLASS_NAME_MAX} characters` })
        }

        const cls = await ownedClass(req.params.id, req.user.id)
        if (!cls) return res.status(404).json({ error: 'Class not found' })

        const trimmed     = newName.trim()
        const yearGroupId = parseYear(trimmed)
        const validYear   = yearGroupId ? await classDb.validateYear(yearGroupId) : null
        if (!validYear) {
            return res.status(400).json({ error: 'Class name must include a valid year (7–11)' })
        }

        const dup = await classDb.findClassByNameExcluding(trimmed, req.user.id, cls.id)
        if (dup) return res.status(409).json({ error: 'You already have another class with this name' })

        await classDb.updateClass(trimmed, yearGroupId, cls.id)

        res.json({ id: cls.id, class_name: trimmed, year_group_id: yearGroupId })
    } catch (err) {
        next(err)
    }
})

// POST /classes/:id/students — add a single student to the class.
router.post('/:id/students', async (req, res, next) => {
    try {
        const { student_name: name } = req.body
        if (!name?.trim()) {
            return res.status(400).json({ error: 'Student name is required' })
        }
        if (name.trim().length > STUDENT_NAME_MAX) {
            return res.status(400).json({ error: `Student name must not exceed ${STUDENT_NAME_MAX} characters` })
        }

        const cls = await ownedClass(req.params.id, req.user.id)
        if (!cls) return res.status(404).json({ error: 'Class not found' })

        const trimmed = name.trim()
        const dup     = await classDb.findStudentByName(trimmed, cls.id)
        if (dup) return res.status(409).json({ error: `"${trimmed}" is already in this class` })

        const { id } = await classDb.insertStudent(trimmed, cls.id)
        res.status(201).json({ id, student_name: trimmed })
    } catch (err) {
        next(err)
    }
})

// PATCH /classes/:id/students/:studentId — rename a student inside this class.
router.patch('/:id/students/:studentId', async (req, res, next) => {
    try {
        const { student_name: newName } = req.body
        if (!newName?.trim()) {
            return res.status(400).json({ error: 'Student name is required' })
        }
        if (newName.trim().length > STUDENT_NAME_MAX) {
            return res.status(400).json({ error: `Student name must not exceed ${STUDENT_NAME_MAX} characters` })
        }

        const cls = await ownedClass(req.params.id, req.user.id)
        if (!cls) return res.status(404).json({ error: 'Class not found' })

        const student = await classDb.findStudentById(req.params.studentId, cls.id)
        if (!student) return res.status(404).json({ error: 'Student not found in this class' })

        const trimmed = newName.trim()
        const dup     = await classDb.findStudentByNameExcluding(trimmed, cls.id, student.id)
        if (dup) return res.status(409).json({ error: `"${trimmed}" is already in this class` })

        await classDb.updateStudent(trimmed, student.id)
        res.json({ id: student.id, student_name: trimmed })
    } catch (err) {
        next(err)
    }
})

// DELETE /classes/:id/students/:studentId — remove a student plus their derived rows.
router.delete('/:id/students/:studentId', async (req, res, next) => {
    try {
        const cls = await ownedClass(req.params.id, req.user.id)
        if (!cls) return res.status(404).json({ error: 'Class not found' })

        const student = await classDb.findStudentById(req.params.studentId, cls.id)
        if (!student) return res.status(404).json({ error: 'Student not found in this class' })

        await classDb.deleteStudent(student.id)
        res.json({ id: student.id, deleted: true })
    } catch (err) {
        next(err)
    }
})

export default router
