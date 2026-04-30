import type { Request, Response, NextFunction } from 'express';
import { logger, formatError } from '../lib/logger.js';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function asyncHandler(fn: AsyncHandler): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch((err: unknown) => {
      logger.error({ err: formatError(err), method: req.method, path: req.path }, 'handler error');
      next(err instanceof Error ? err : new Error(String(err)));
    });
  };
}
