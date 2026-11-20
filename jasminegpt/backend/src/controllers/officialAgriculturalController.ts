import { Request, Response, NextFunction } from 'express';
import { officialGet, officialPost } from '../services/officialAgriculturalClient';

export async function handleOfficialHealth(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.json(await officialGet('/health'));
  } catch (error) {
    next(error);
  }
}

export async function handleOfficialDatabaseStatus(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.json(await officialGet('/db-status'));
  } catch (error) {
    next(error);
  }
}

export async function handleOfficialSources(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.json(await officialGet('/sources'));
  } catch (error) {
    next(error);
  }
}

export async function handleOfficialChat(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.json(await officialPost('/chat', req.body));
  } catch (error) {
    next(error);
  }
}

export async function handleOfficialSearch(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.json(await officialPost('/search', req.body));
  } catch (error) {
    next(error);
  }
}

export async function handleOfficialDeepSearch(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.json(await officialPost('/deep-search'));
  } catch (error) {
    next(error);
  }
}

export async function handleOfficialReloadChroma(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.json(await officialPost('/admin/reload-chroma'));
  } catch (error) {
    next(error);
  }
}
