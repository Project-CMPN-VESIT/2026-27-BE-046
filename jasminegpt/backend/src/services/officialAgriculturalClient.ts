import axios, { AxiosError } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';

const officialClient = axios.create({
  baseURL: env.OFFICIAL_AGRICULTURAL_SERVICE_URL,
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

function rethrowOfficialServiceError(error: unknown): never {
  const axiosError = error as AxiosError<{ detail?: string }>;
  logger.error(
    { err: axiosError.message, service: env.OFFICIAL_AGRICULTURAL_SERVICE_URL },
    'Official agricultural service request failed',
  );
  if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ENOTFOUND' || axiosError.code === 'ETIMEDOUT') {
    throw Errors.OFFICIAL_AGRICULTURAL_UNAVAILABLE();
  }
  throw Errors.INTERNAL(
    axiosError.response?.data?.detail ?? 'Official agricultural service request failed',
  );
}

export async function officialGet<T>(path: string): Promise<T> {
  try {
    const response = await officialClient.get<T>(path);
    return response.data;
  } catch (error) {
    return rethrowOfficialServiceError(error);
  }
}

export async function officialPost<T>(path: string, body?: unknown): Promise<T> {
  try {
    const response = await officialClient.post<T>(path, body);
    return response.data;
  } catch (error) {
    return rethrowOfficialServiceError(error);
  }
}
