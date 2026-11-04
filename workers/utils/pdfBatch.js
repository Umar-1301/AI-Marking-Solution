import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'

export const OCR_PAGES_PER_REQUEST = 6

// Entries stay in claim order. Each output page has a stable job/page key,
// including pages copied from a multi-page student PDF.
export async function buildOcrPdfChunks(entries) {
    const chunks = []
    let combined = await PDFDocument.create()
    let pages = []

    async function flush() {
        if (!pages.length) return
        chunks.push({ buffer: Buffer.from(await combined.save()), pages })
        combined = await PDFDocument.create()
        pages = []
    }

    for (const { job, file } of entries) {
        if (file.mimetype === 'application/pdf') {
            const source = await PDFDocument.load(file.buffer)
            if (source.getPageCount() !== file.pageCount) {
                throw new Error(`Validated PDF page count changed for job ${job.jobId}`)
            }
            for (let index = 0; index < file.pageCount; index++) {
                if (pages.length === OCR_PAGES_PER_REQUEST) await flush()
                const [page] = await combined.copyPages(source, [index])
                combined.addPage(page)
                pages.push({ jobId: job.jobId, pageIndex: index,
                    key: `${job.jobId}:page:${index}`, sourceName: file.sourceName })
            }
        } else {
            if (pages.length === OCR_PAGES_PER_REQUEST) await flush()
            const { width } = await sharp(file.buffer).metadata()
            const imageBytes = await sharp(file.buffer)
                .resize({ width: Math.max(1, Math.round(width * 2 / 3)) })
                .jpeg({ quality: 50 }).toBuffer()
            const image = await combined.embedJpg(imageBytes)
            const page = combined.addPage([image.width, image.height])
            page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
            pages.push({ jobId: job.jobId, pageIndex: 0,
                key: `${job.jobId}:page:0`, sourceName: file.sourceName })
        }
    }
    await flush()
    return chunks
}

export function mapOcrPagesToJobs(entries, textByPage) {
    const textByJob = new Map()
    const emptyByJob = new Set()
    for (const { job, file } of entries) {
        const texts = Array.from({ length: file.pageCount }, (_, index) =>
            textByPage.get(`${job.jobId}:page:${index}`)).filter(Boolean)
        if (texts.length) textByJob.set(job.jobId, texts.join('\n\n'))
        else emptyByJob.add(job.jobId)
    }
    return { textByJob, emptyByJob }
}
