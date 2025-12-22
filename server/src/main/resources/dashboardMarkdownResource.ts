import {Request, Response} from 'express';
import fs from 'fs';
import path from 'path';

export default async function dashboardMarkdownResource(req: Request, res: Response) {
    const file = req.query.file as string;
    if (!file) return res.status(400).json({error: 'Missing ?file'});

    try {
        const resolved: string = path.isAbsolute(file)
            ? file
            : path.resolve(__dirname, '../../../..', file);

        console.log('[dashboardMarkdownResource] requested file:', file);
        console.log('[dashboardMarkdownResource] resolved path:', resolved);

        if (!fs.existsSync(resolved)) return res.status(404).json({error: 'File not found'});
        if (!resolved.endsWith('.md')) return res.status(400).json({error: 'Invalid format (must end in .md)'});

        const content: string = fs.readFileSync(resolved, 'utf-8');
        res.json({content});
    } catch (err) {
        res.status(500).json({error: 'Failed to read file', details: String(err)});
    }
}
