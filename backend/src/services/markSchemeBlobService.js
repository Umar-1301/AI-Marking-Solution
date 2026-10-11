import { BlobSASPermissions } from '@azure/storage-blob'
import { blobServiceClient, usingManagedIdentity } from './blobService.js'

const containerClient = blobServiceClient.getContainerClient('mark-schemes')
const SAS_MINUTES = 10

export function markSchemeBlobName(teacherId, jobId) {
    return `${teacherId}/${jobId}/source`
}

export async function generateMarkSchemeUploadUrl(blobName) {
    const client = containerClient.getBlockBlobClient(blobName)
    const expiresOn = new Date(Date.now() + SAS_MINUTES * 60 * 1000)
    const options = {
        permissions: BlobSASPermissions.from({ create: true, write: true }),
        expiresOn,
    }

    if (usingManagedIdentity) {
        const key = await blobServiceClient.getUserDelegationKey(new Date(), expiresOn)
        return client.generateUserDelegationSasUrl(options, key)
    }
    return client.generateSasUrl(options)
}

export async function getMarkSchemeProperties(blobName) {
    try {
        return await containerClient.getBlockBlobClient(blobName).getProperties()
    } catch (err) {
        if (err.statusCode === 404) return null
        throw err
    }
}

export async function downloadMarkScheme(blobName, etag) {
    const client = containerClient.getBlockBlobClient(blobName)
    return client.downloadToBuffer(0, undefined, {
        conditions: { ifMatch: etag },
    })
}
