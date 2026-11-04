import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import heicConvert from 'heic-convert'
import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib'
import { MAX_STUDENT_FILE_BYTES, StudentFileValidationError } from './fileSecurity.js'

function removeActions(context, dict) {
    if (!(dict instanceof PDFDict)) return
    dict.delete(PDFName.of('AA'))
    const action = context.lookup(dict.get(PDFName.of('A')))
    if (action instanceof PDFDict && action.get(PDFName.of('S'))?.toString() === '/JavaScript') {
        dict.delete(PDFName.of('A'))
    }
}

function removeFieldActions(context, fields) {
    if (!(fields instanceof PDFArray)) return
    for (let index = 0; index < fields.size(); index++) {
        const field = context.lookup(fields.get(index))
        if (!(field instanceof PDFDict)) continue
        removeActions(context, field)
        removeFieldActions(context, context.lookup(field.get(PDFName.of('Kids'))))
    }
}

async function stripPdfMetadata(buffer) {
    const pdf = await PDFDocument.load(buffer)
    pdf.setTitle('')
    pdf.setAuthor('')
    pdf.setSubject('')
    pdf.setKeywords([])
    pdf.setCreator('')
    pdf.setProducer('')
    pdf.setCreationDate(new Date(0))
    pdf.setModificationDate(new Date(0))
    const { context, catalog } = pdf
    catalog.delete(PDFName.of('OpenAction'))
    catalog.delete(PDFName.of('AA'))
    const names = context.lookup(catalog.get(PDFName.of('Names')))
    if (names instanceof PDFDict) names.delete(PDFName.of('JavaScript'))
    for (const page of pdf.getPages()) {
        page.node.delete(PDFName.of('AA'))
        const annotations = context.lookup(page.node.get(PDFName.of('Annots')))
        if (annotations instanceof PDFArray) {
            for (let index = 0; index < annotations.size(); index++) {
                removeActions(context, context.lookup(annotations.get(index)))
            }
        }
    }
    const form = context.lookup(catalog.get(PDFName.of('AcroForm')))
    if (form instanceof PDFDict) {
        form.delete(PDFName.of('XFA'))
        removeFieldActions(context, context.lookup(form.get(PDFName.of('Fields'))))
    }
    return Buffer.from(await pdf.save())
}

export async function validateStudentFile(file) {
    const detected = await fileTypeFromBuffer(file.buffer)
    if (!detected || detected.mime !== file.mimetype) {
        throw new StudentFileValidationError('Student file content does not match its declared type')
    }
    try {
        let buffer
        if (file.mimetype === 'application/pdf') {
            buffer = await stripPdfMetadata(file.buffer)
        } else {
            const source = ['image/heic', 'image/heif'].includes(file.mimetype)
                ? Buffer.from(await heicConvert({ buffer: file.buffer, format: 'JPEG', quality: 0.95 }))
                : file.buffer
            buffer = await sharp(source).rotate().jpeg({ quality: 95 }).toBuffer()
        }
        if (buffer.length > MAX_STUDENT_FILE_BYTES) {
            throw new StudentFileValidationError('Student file exceeds 5 MB after processing')
        }
        const pdf = file.mimetype === 'application/pdf'
        return {
            ...file,
            buffer,
            mimetype: pdf ? 'application/pdf' : 'image/jpeg',
            originalname: pdf ? file.originalname
                : file.originalname.replace(/\.[^.]+$/, '.jpg'),
            sourceName: file.originalname,
        }
    } catch (err) {
        if (err instanceof StudentFileValidationError) throw err
        throw new StudentFileValidationError('Student file could not be decoded')
    }
}
