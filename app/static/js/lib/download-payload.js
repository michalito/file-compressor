export function ensureDownloadPayload(entry) {
  if (entry?.artifactRefs?.download?.artifact_id) {
    return { kind: 'artifact', artifactId: entry.artifactRefs.download.artifact_id };
  }

  if (entry?.processedData?.data) {
    return { kind: 'inline', data: entry.processedData.data };
  }

  throw new Error('This result is missing its downloadable output. Retry the image.');
}
