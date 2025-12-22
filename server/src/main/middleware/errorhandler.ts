import { PostgrestError } from '@supabase/supabase-js';
import { Request, Response } from 'express';

export class ErrorHandler {

    // *if types give you trouble with an error add its type here
    errorHandler(err: PostgrestError, req: Request, res: Response) {
        const routePath = req.path;

        console.error(`Error in route (${routePath}):`, err);

        // Send an error response to the client
        res.status(500).json({ error: 'Something went wrong' });
    }
}