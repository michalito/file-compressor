import { api } from './api.js';

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return null;
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let scaled = size;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${formatNumber(Math.round(scaled))} bytes`;
  return `${scaled.toFixed(1)} ${units[unitIndex]}`;
}

function buildFriendlyAIUpscaleError(payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object') {
    return fallbackMessage;
  }

  if (payload.user_message) {
    return payload.user_message;
  }

  if (payload.code === 'memory_budget_exceeded') {
    const projected = payload.projected_output || {};
    const hasDimensions = Number.isFinite(projected.width) && Number.isFinite(projected.height);
    const outputLabel = hasDimensions
      ? `${formatNumber(projected.width)} x ${formatNumber(projected.height)}`
      : 'requested output size';
    const estimated = formatBytes(payload.estimated_peak_bytes);
    const softLimit = formatBytes(payload.memory_soft_limit_bytes);
    let message = 'This image is too large for AI upscaling on the current server.';
    if (estimated && softLimit) {
      message += ` The ${outputLabel} upscale is estimated to need about ${estimated}, above the safe working limit of about ${softLimit}.`;
    } else if (hasDimensions) {
      message += ` The ${outputLabel} upscale is too large for the current server memory limit.`;
    }
    if (payload.suggested_scale) {
      message += ` Try ${payload.suggested_scale}x instead.`;
    }
    return message;
  }

  if (payload.code === 'output_limit_exceeded') {
    const projected = payload.projected_output || {};
    if (Number.isFinite(projected.width) && Number.isFinite(projected.height)) {
      let message = `This image would become ${formatNumber(projected.width)} x ${formatNumber(projected.height)}, which is larger than this app allows.`;
      if (payload.suggested_scale) {
        message += ` Try ${payload.suggested_scale}x instead.`;
      }
      return message;
    }
  }

  return payload.error || payload.reason || fallbackMessage;
}

async function parseError(response) {
  let message = `HTTP ${response.status}`;
  let payload = null;
  try {
    payload = await response.clone().json();
    message = buildFriendlyAIUpscaleError(payload, message);
  } catch {
    // Ignore JSON parse failures.
  }

  const error = new Error(message);
  error.status = response.status;
  if (payload?.code) error.code = payload.code;
  if (payload) error.payload = payload;
  return error;
}

export async function getAIUpscaleHealth({ signal } = {}) {
  const response = await api('/ai-upscale/health', { signal });
  try {
    const payload = await response.json();
    payload.httpStatus = response.status;
    return payload;
  } catch {
    return {
      enabled: false,
      healthy: false,
      state: 'error',
      backend: null,
      worker_instance_id: null,
      started_at: null,
      reason: 'AI upscaling service is unavailable.',
      details: {},
      httpStatus: response.status,
    };
  }
}

export async function createAIUpscaleJob(formData, { signal } = {}) {
  const response = await api('/ai-upscale/jobs', {
    method: 'POST',
    body: formData,
    signal,
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return response.json();
}

export async function getAIUpscaleJob(jobId, { signal } = {}) {
  const response = await api(`/ai-upscale/jobs/${jobId}`, { signal });
  if (!response.ok) {
    throw await parseError(response);
  }
  return response.json();
}

export async function cancelAIUpscaleJob(jobId, { signal } = {}) {
  const response = await api(`/ai-upscale/jobs/${jobId}/cancel`, {
    method: 'POST',
    signal,
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return response.json();
}

export async function deleteAIUpscaleJob(jobId, { signal } = {}) {
  const response = await api(`/ai-upscale/jobs/${jobId}`, {
    method: 'DELETE',
    signal,
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return response.json();
}

export async function downloadAIArtifact(artifactId, { signal } = {}) {
  const response = await api(`/ai-upscale/artifacts/${artifactId}/download`, { signal });
  if (!response.ok) {
    throw await parseError(response);
  }
  return response.blob();
}

export async function downloadAIArtifacts(artifacts, { signal } = {}) {
  const response = await api('/ai-upscale/download-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artifacts }),
    signal,
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return response.blob();
}
