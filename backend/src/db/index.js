import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { initSchema } from './schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const DB_PATH = join(__dirname, '..', 'data', 'aimira.sqlite')

const db = new Database(DB_PATH)

// WAL gives concurrent reads + a writer without blocking; foreign_keys must
// be enabled per-connection — SQLite defaults to off for backwards compat.
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Build the schema BEFORE preparing any statements below. On a fresh database
// (e.g. a new container) the tables don't exist yet, and db.prepare() against a
// missing table throws — so the schema must be created here first.
initSchema(db)

// Least-privilege accessor for the teachers table only.
// Prepared once at startup — users.js imports this instead of the raw db
// connection so it cannot run arbitrary SQL against any other table.
const _teacherFind   = db.prepare('SELECT * FROM teachers WHERE email_hash = ?')
const _teacherInsert = db.prepare('INSERT INTO teachers (name, email_hash, password_hash) VALUES (?, ?, ?)')

export const teacherDb = {
    findByEmailHash: (emailHash) => _teacherFind.get(emailHash),
    insert:          (name, emailHash, passwordHash) => _teacherInsert.run(name, emailHash, passwordHash),
}

// Least-privilege accessor for the lessons flow only.
// Covers: ownership check on classes, lesson creation, and OCR storage.
// lessons.js imports this instead of the raw db connection.
const _listLessons       = db.prepare(`
    SELECT l.id, l.lesson_title, l.class_id, l.created_at, c.class_name
    FROM lessons l
    JOIN classes c ON l.class_id = c.id
    WHERE c.teacher_id = ?
    ORDER BY l.created_at DESC
`)
const _findLesson        = db.prepare(`
    SELECT l.id, l.lesson_title, l.class_id, c.class_name
    FROM lessons l
    JOIN classes c ON l.class_id = c.id
    WHERE l.id = ? AND c.teacher_id = ?
`)
const _lessonClassCheck  = db.prepare('SELECT id, class_name FROM classes WHERE id = ? AND teacher_id = ?')
const _lessonInsert      = db.prepare('INSERT INTO lessons (lesson_title, class_id, mark_scheme_file_name, mark_scheme_mime_type) VALUES (?, ?, ?, ?)')
const _teacherOcrInsert  = db.prepare('INSERT INTO teacher_ocr (lesson_id, ocr_text) VALUES (?, ?)')
const _lessonOcrLink     = db.prepare('UPDATE lessons SET mark_scheme_ocr = ? WHERE id = ?')
const _lessonOcrText     = db.prepare(`
    SELECT t.ocr_text
    FROM teacher_ocr t
    JOIN lessons l ON t.lesson_id = l.id
    JOIN classes c ON l.class_id = c.id
    WHERE l.id = ? AND c.teacher_id = ?
`)

const _createLessonTx = db.transaction((lessonTitle, classId, fileName, mimeType, ocrText) => {
    const { lastInsertRowid: lessonId } = _lessonInsert.run(lessonTitle, classId, fileName, mimeType)
    const { lastInsertRowid: ocrId }    = _teacherOcrInsert.run(lessonId, ocrText)
    _lessonOcrLink.run(ocrId, lessonId)
    return lessonId
})

export const lessonDb = {
    listLessons:  (teacherId)                                      => _listLessons.all(teacherId),
    findLesson:   (lessonId, teacherId)                            => _findLesson.get(lessonId, teacherId),
    findClass:    (classId, teacherId)                              => _lessonClassCheck.get(classId, teacherId),
    createLesson: (lessonTitle, classId, fileName, mimeType, ocrText) => _createLessonTx(lessonTitle, classId, fileName, mimeType, ocrText),
    getOcrText:   (lessonId, teacherId)                            => _lessonOcrText.get(lessonId, teacherId),
}

// Least-privilege accessor for the classes flow only.
// Covers all class and student CRUD operations.
// classes.js imports this instead of the raw db connection.
const _listClasses              = db.prepare(`
    SELECT c.id, c.class_name, c.year_group_id, COUNT(s.id) AS student_count
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id
    WHERE c.teacher_id = ?
    GROUP BY c.id
    ORDER BY c.class_name
`)
const _findClassById            = db.prepare('SELECT id, class_name, year_group_id FROM classes WHERE id = ? AND teacher_id = ?')
const _findClassByName          = db.prepare('SELECT id FROM classes WHERE class_name = ? AND teacher_id = ?')
const _findClassByNameExcluding = db.prepare('SELECT id FROM classes WHERE class_name = ? AND teacher_id = ? AND id != ?')
const _validateYear             = db.prepare('SELECT id FROM year_groups WHERE id = ?')
const _insertClass              = db.prepare('INSERT INTO classes (class_name, year_group_id, teacher_id) VALUES (?, ?, ?)')
const _updateClass              = db.prepare('UPDATE classes SET class_name = ?, year_group_id = ? WHERE id = ?')
const _listStudents             = db.prepare('SELECT id, student_name FROM students WHERE class_id = ? ORDER BY student_name')
const _findStudentByName        = db.prepare('SELECT id FROM students WHERE student_name = ? AND class_id = ?')
const _findStudentByNameExcluding = db.prepare('SELECT id FROM students WHERE student_name = ? AND class_id = ? AND id != ?')
const _findStudentById          = db.prepare('SELECT id FROM students WHERE id = ? AND class_id = ?')
const _insertStudent            = db.prepare('INSERT INTO students (student_name, class_id) VALUES (?, ?)')
const _updateStudent            = db.prepare('UPDATE students SET student_name = ? WHERE id = ?')
const _delMarkingResults        = db.prepare('DELETE FROM marking_results WHERE student_id = ?')
const _delStudentOcr            = db.prepare('DELETE FROM student_ocr WHERE file_id IN (SELECT id FROM student_files WHERE student_id = ?)')
const _delStudentFiles          = db.prepare('DELETE FROM student_files WHERE student_id = ?')
const _delStudent               = db.prepare('DELETE FROM students WHERE id = ?')

const _deleteStudentTx = db.transaction((studentId) => {
    _delMarkingResults.run(studentId)
    _delStudentOcr.run(studentId)
    _delStudentFiles.run(studentId)
    _delStudent.run(studentId)
})

export const classDb = {
    listClasses:               (teacherId)                         => _listClasses.all(teacherId),
    findClassById:             (classId, teacherId)                => _findClassById.get(classId, teacherId),
    findClassByName:           (className, teacherId)              => _findClassByName.get(className, teacherId),
    findClassByNameExcluding:  (className, teacherId, classId)     => _findClassByNameExcluding.get(className, teacherId, classId),
    validateYear:              (yearId)                            => _validateYear.get(yearId),
    insertClass:               (className, yearGroupId, teacherId) => _insertClass.run(className, yearGroupId, teacherId),
    updateClass:               (className, yearGroupId, classId)   => _updateClass.run(className, yearGroupId, classId),
    listStudents:              (classId)                           => _listStudents.all(classId),
    findStudentByName:         (studentName, classId)              => _findStudentByName.get(studentName, classId),
    findStudentByNameExcluding:(studentName, classId, studentId)   => _findStudentByNameExcluding.get(studentName, classId, studentId),
    findStudentById:           (studentId, classId)                => _findStudentById.get(studentId, classId),
    insertStudent:             (studentName, classId)              => _insertStudent.run(studentName, classId),
    updateStudent:             (studentName, studentId)            => _updateStudent.run(studentName, studentId),
    deleteStudent:             (studentId)                         => _deleteStudentTx(studentId),
    transaction:               (fn)                                => db.transaction(fn)(),
}

export default db
