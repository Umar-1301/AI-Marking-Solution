import { BlobServiceClient, BlobSASPermissions } from '@azure/storage-blob'
import config from '../config/index.js'

const CONTAINER_NAME = 'student-work'
const UPLOAD_SAS_TTL_MINUTES = 10

const blobServiceClient = BlobServiceClient.fromConnectionString(config.AZURE_STORAGE_CONNECTION_STRING)
const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME)

// Ownership lives entirely in this path, not in any check blob storage
// itself performs — teacherId/lessonId/studentId must always be values
// already validated server-side by the caller (see the upload-url route),
// never anything read from the request body or params directly.
function blobPathFor(teacherId, lessonId, studentId, fileName) {
    return `${teacherId}/${lessonId}/${studentId}/${fileName}`
}

// A short-lived, write-only SAS URL scoped to exactly one blob. Signed with
// the account key held by blobServiceClient's credential (see
// AZURE_STORAGE_CONNECTION_STRING) — that key never leaves this process,
// only the resulting signed URL is returned to the caller.
export function generateUploadUrl(teacherId, lessonId, studentId, fileName) {
    const blobPath = blobPathFor(teacherId, lessonId, studentId, fileName)
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath)

    return blockBlobClient.generateSasUrl({
        permissions: BlobSASPermissions.from({ create: true, write: true }),
        expiresOn: new Date(Date.now() + UPLOAD_SAS_TTL_MINUTES * 60 * 1000),
    })
}
