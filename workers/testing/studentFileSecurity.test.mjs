import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { PDFDocument } from 'pdf-lib'
import {
    checkStudentFile, StudentFileValidationError,
} from '../security/fileSecurity.js'
import { validateStudentFile } from '../security/validateFile.js'
import { buildOcrPdfChunks, mapOcrPagesToJobs } from '../utils/pdfBatch.js'

async function prepare(buffer, originalname, mimetype) {
    return validateStudentFile(await checkStudentFile({ buffer, originalname, mimetype }))
}

test('JPEG, PNG, WebP and multi-page PDF join in source order across six-page chunks', async () => {
    const jpeg = await sharp({ create: { width: 60, height: 80, channels: 3,
        background: 'red' } }).jpeg().toBuffer()
    const png = await sharp({ create: { width: 60, height: 80, channels: 3,
        background: 'blue' } }).png().toBuffer()
    const webp = await sharp({ create: { width: 60, height: 80, channels: 3,
        background: 'green' } }).webp().toBuffer()
    const pdf = await PDFDocument.create()
    for (let index = 0; index < 5; index++) pdf.addPage([80, 100])
    const entries = await Promise.all([
        ['a', jpeg, 'a.jpg', 'image/jpeg'],
        ['b', png, 'b.png', 'image/png'],
        ['c', Buffer.from(await pdf.save()), 'c.pdf', 'application/pdf'],
        ['d', webp, 'd.webp', 'image/webp'],
    ].map(async ([jobId, buffer, name, mime]) => ({
        job: { jobId }, file: await prepare(buffer, name, mime),
    })))
    assert.deepEqual(entries.map(entry => entry.file.pageCount), [1, 1, 5, 1])
    assert.deepEqual(entries.map(entry => entry.file.mimetype), [
        'image/jpeg', 'image/jpeg', 'application/pdf', 'image/jpeg',
    ])
    const chunks = await buildOcrPdfChunks(entries)
    assert.deepEqual(chunks.map(chunk => chunk.pages.length), [6, 2])
    assert.deepEqual(chunks.flatMap(chunk => chunk.pages.map(page => page.key)), [
        'a:page:0', 'b:page:0', 'c:page:0', 'c:page:1', 'c:page:2',
        'c:page:3', 'c:page:4', 'd:page:0',
    ])
    for (const chunk of chunks) {
        const merged = await PDFDocument.load(chunk.buffer)
        assert.equal(merged.getPageCount(), chunk.pages.length)
    }
    const pageTexts = new Map(chunks.flatMap(chunk => chunk.pages.map(page => [
        page.key, `${page.jobId} answer page ${page.pageIndex}`,
    ])))
    const { textByJob, emptyByJob } = mapOcrPagesToJobs(entries, pageTexts)
    assert.equal(textByJob.get('c'), [0, 1, 2, 3, 4]
        .map(index => `c answer page ${index}`).join('\n\n'))
    assert.equal(textByJob.get('d'), 'd answer page 0')
    assert.equal(emptyByJob.size, 0)
})

test('bad filename, MIME mismatch, unreadable image and oversized PDF fail validation', async () => {
    const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3,
        background: 'white' } }).jpeg().toBuffer()
    await assert.rejects(prepare(jpeg, 'bad.name.jpg', 'image/jpeg'), StudentFileValidationError)
    await assert.rejects(prepare(jpeg, 'bad.png', 'image/png'), StudentFileValidationError)
    await assert.rejects(prepare(Buffer.from('not an image'), 'bad.jpg', 'image/jpeg'),
        StudentFileValidationError)
    const pdf = await PDFDocument.create()
    for (let index = 0; index < 31; index++) pdf.addPage([80, 100])
    await assert.rejects(checkStudentFile({
        buffer: Buffer.from(await pdf.save()), originalname: 'too-long.pdf',
        mimetype: 'application/pdf',
    }), StudentFileValidationError)
})

test('a 30-page student PDF uses five six-page OCR requests', async () => {
    const pdf = await PDFDocument.create()
    for (let index = 0; index < 30; index++) pdf.addPage([80, 100])
    const file = await prepare(Buffer.from(await pdf.save()), 'student.pdf', 'application/pdf')
    const chunks = await buildOcrPdfChunks([{ job: { jobId: 'student-job' }, file }])
    assert.deepEqual(chunks.map(chunk => chunk.pages.length), [6, 6, 6, 6, 6])
    assert.equal(chunks[4].pages[5].key, 'student-job:page:29')
})
