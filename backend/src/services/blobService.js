import { BlobServiceClient, BlobSASPermissions } from '@azure/storage-blob'
import config from '../config/index.js'

const CONTAINER_NAME = 'student-work'
const UPLOAD_SAS_TTL_MINUTES = 10

const blobServiceClient = BlobServiceClient.fromConnectionString(
    config.AZURE_STORAGE_CONNECTION_STRING
)
const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME)

// These identifiers must already have been authorised by the route before
// they are used to construct or search a Blob Storage path.
function blobPathFor(teacherId, lessonId, studentId, fileName) {
    return `${teacherId}/${lessonId}/${studentId}/${fileName}`
}

export function generateUploadUrl(teacherId, lessonId, studentId, fileName) {
    const blobPath = blobPathFor(
        teacherId,
        lessonId,
        studentId,
        fileName
    )
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath)

    return blockBlobClient.generateSasUrl({
        permissions: BlobSASPermissions.from({
            create: true,
            write: true,
        }),
        expiresOn: new Date(
            Date.now() + UPLOAD_SAS_TTL_MINUTES * 60 * 1000
        ),
    })
}

// Finds the most recently uploaded Blob for this student. Choosing the most
// recent Blob is necessary because uploading a replacement with a different
// filename leaves the previous Blob under the same student prefix.
export async function findStudentUpload(teacherId, lessonId, studentId) {
    const prefix = `${teacherId}/${lessonId}/${studentId}/`
    let latestBlob = null

    for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        const relativeName = blob.name.slice(prefix.length)

        if (!relativeName) continue

        if (!latestBlob) {
            latestBlob = blob
            continue
        }

        const candidateTime = blob.properties.lastModified?.getTime() ?? 0
        const latestTime =
            latestBlob.properties.lastModified?.getTime() ?? 0

        const isNewer =
            candidateTime > latestTime ||
            (
                candidateTime === latestTime &&
                blob.name.localeCompare(latestBlob.name) > 0
            )

        if (isNewer) latestBlob = blob
    }

    if (!latestBlob) return null

    return {
        blobName: latestBlob.name,
        fileName: latestBlob.name.slice(prefix.length),
        mimeType: latestBlob.properties.contentType || 'application/octet-stream',
    }
}
// Taking the prefix defined at the top, we loop through the entirety of that blob, and 
// return the newest blob based on the last modified date. This is necessary because if a 
// student uploads a new file with a different name, the old file will still exist in the blob 
// storage, and we want to return the most recent one.


export async function downloadStudentWork(blobName) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName)

    return blockBlobClient.downloadToBuffer()
}
// This function takes a blob name and downloads the contents of that blob to a buffer, which can then be 
// used for further processing or returned to the client.


