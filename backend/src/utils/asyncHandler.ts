import { Request, Response, NextFunction } from 'express';

type AsyncFn = (req: any, res: Response, next: NextFunction) => Promise<any>;

export const wrap = (fn: AsyncFn) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);
