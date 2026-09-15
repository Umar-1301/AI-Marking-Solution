import { BlobServiceClient } from '@azure/storage-blob'
import { DefaultAzureCredential } from '@azure/identity'

const CONTAINER_NAME = 'student-work'
const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING || null
const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL || null

if (!connectionString && !accountUrl) {
    throw new Error(
        'Neither AZURE_STORAGE_CONNECTION_STRING (local) nor ' +
        'AZURE_STORAGE_ACCOUNT_URL (production) is set'
    )
}

const blobServiceClient = connectionString
    ? BlobServiceClient.fromConnectionString(connectionString)
    : new BlobServiceClient(accountUrl, new DefaultAzureCredential())

const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME)

// The backend has already authorised these identifiers. With the deliberately
// small three-ID queue message, the worker locates the newest uploaded Blob
// under the same path convention used by the backend.
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
        const latestTime = latestBlob.properties.lastModified?.getTime() ?? 0
        const isNewer = candidateTime > latestTime || (
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

export async function downloadStudentWork(blobName) {
    return containerClient.getBlockBlobClient(blobName).downloadToBuffer()
}

