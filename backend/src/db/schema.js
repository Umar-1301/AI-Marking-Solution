import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Builds the full schema: creates every table (idempotent via IF NOT EXISTS),
// seeds the read-only year_groups reference data, and migrates any legacy
// users.json accounts. Called by db/index.js immediately after the connection
// opens and BEFORE any prepared statements are built — so a fresh database
// (e.g. a brand-new container) has its tables in place before the accessors run.
export function initSchema(db) {
    // ── Reference table ───────────────────────────────────────────────────────
    db.exec(`
        CREATE TABLE IF NOT EXISTS year_groups (
            id    INTEGER PRIMARY KEY,
            label TEXT    NOT NULL UNIQUE
        );
    `)

    const yearGroupCount = db.prepare('SELECT COUNT(*) AS count FROM year_groups').get().count

    if (yearGroupCount === 0) {
        const seed = db.prepare('INSERT INTO year_groups (id, label) VALUES (?, ?)')
        db.transaction(() => {
            seed.run(7,  'Year 7')
            seed.run(8,  'Year 8')
            seed.run(9,  'Year 9')
            seed.run(10, 'Year 10')
            seed.run(11, 'Year 11')
        })()
    }

    // Triggers added after seed — they would block the inserts above if added first.
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS year_groups_no_insert
        BEFORE INSERT ON year_groups
        BEGIN
            SELECT RAISE(FAIL, 'year_groups is a read-only reference table');
        END;

        CREATE TRIGGER IF NOT EXISTS year_groups_no_update
        BEFORE UPDATE ON year_groups
        BEGIN
            SELECT RAISE(FAIL, 'year_groups is a read-only reference table');
        END;

        CREATE TRIGGER IF NOT EXISTS year_groups_no_delete
        BEFORE DELETE ON year_groups
        BEGIN
            SELECT RAISE(FAIL, 'year_groups is a read-only reference table');
        END;
    `)

    // ── Teacher table ─────────────────────────────────────────────────────────
    // email_hash: HMAC-SHA256 of the lowercased email — never stores the raw address.
    // password_hash: bcrypt hash of the peppered password.
    db.exec(`
        CREATE TABLE IF NOT EXISTS teachers (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT    NOT NULL,
            email_hash    TEXT    NOT NULL UNIQUE,
            password_hash TEXT    NOT NULL,
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );
    `)

    // Migrate any accounts that exist in the legacy users.json flat file.
    // INSERT OR IGNORE skips rows whose email_hash is already present — safe to run on every restart.
    try {
        const __dirname = dirname(fileURLToPath(import.meta.url))
        const usersPath = join(__dirname, '..', 'data', 'users.json')
        const legacyUsers = JSON.parse(readFileSync(usersPath, 'utf-8'))

        const insert = db.prepare(`
            INSERT OR IGNORE INTO teachers (name, email_hash, password_hash, created_at)
            VALUES (?, ?, ?, ?)
        `)

        db.transaction(() => {
            for (const u of legacyUsers) {
                insert.run(u.name, u.emailHash, u.passwordHash, u.createdAt)
            }
        })()
    } catch {
        // users.json absent or already deleted — nothing to migrate
    }

    // ── Class and student tables ──────────────────────────────────────────────
    // classes.year_group_id  — a class belongs to exactly one year.
    // classes.teacher_id     — a class belongs to exactly one teacher.
    // students.class_id      — a student belongs to exactly one class;
    //                          their year is derived via class → year_groups.
    db.exec(`
        CREATE TABLE IF NOT EXISTS classes (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            class_name    TEXT    NOT NULL,
            year_group_id INTEGER NOT NULL REFERENCES year_groups(id),
            teacher_id    INTEGER NOT NULL REFERENCES teachers(id)
        );

        CREATE TABLE IF NOT EXISTS students (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            student_name TEXT    NOT NULL,
            class_id     INTEGER NOT NULL REFERENCES classes(id)
        );
    `)

    // ── File and OCR tables ────────────────────────────────────────────────────
    db.exec(`
        CREATE TABLE IF NOT EXISTS student_files (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id  INTEGER NOT NULL REFERENCES students(id),
            lesson_id   INTEGER NOT NULL REFERENCES lessons(id),
            file_name   TEXT    NOT NULL,
            mime_type   TEXT    NOT NULL,
            uploaded_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS student_ocr (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id  INTEGER NOT NULL UNIQUE REFERENCES student_files(id),
            ocr_text TEXT    NOT NULL,
            ocr_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );
    `)

    // ── Lesson and marking tables ──────────────────────────────────────────────
    // lessons         — one row per marking session for a class; mark scheme stored once here.
    //                   mark_scheme_ocr stores the teacher_ocr row id (back-reference, no FK).
    // teacher_ocr     — one row per lesson; holds the OCR text extracted from the mark scheme.
    // marking_results — one row per student per lesson; UNIQUE(lesson_id, student_id)
    //                   prevents a student being graded twice in the same lesson.
    db.exec(`
        CREATE TABLE IF NOT EXISTS lessons (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_title          TEXT    NOT NULL,
            class_id              INTEGER NOT NULL REFERENCES classes(id),
            mark_scheme_file_name TEXT    NOT NULL,
            mark_scheme_mime_type TEXT    NOT NULL,
            mark_scheme_ocr       INTEGER,
            created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS teacher_ocr (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id  INTEGER NOT NULL REFERENCES lessons(id),
            ocr_text   TEXT    NOT NULL,
            created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS marking_results (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id     INTEGER NOT NULL REFERENCES lessons(id),
            student_id    INTEGER NOT NULL REFERENCES students(id),
            ocr_id        INTEGER NOT NULL UNIQUE REFERENCES student_ocr(id),
            student_grade TEXT    NOT NULL,
            marked_at     TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE (lesson_id, student_id)
        );
    `)
}
