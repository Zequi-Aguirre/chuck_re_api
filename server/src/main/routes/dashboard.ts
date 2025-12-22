import express from 'express';
import fs from 'fs';
import path from 'path';
import dashboardMarkdownResource from '../resources/dashboardMarkdownResource';

const router = express.Router();

// Serve dashboard layout config
router.get('/dashboard/layout', (_req, res) => {
    const layoutPath = '/tmp/dashboard_layout.json';
    if (fs.existsSync(layoutPath)) {
        const content = fs.readFileSync(layoutPath, 'utf-8');
        res.json(JSON.parse(content));
    } else {
        res.status(404).json({error: 'Layout file not found'});
    }
});

// Serve Markdown content dynamically
router.get('/dashboard/markdown', dashboardMarkdownResource);

// make a combined version of the above two routes with headers
router.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../../../client/public/dashboard/index.html'));
});

router.use(
    '/dashboard',
    express.static(path.join(__dirname, '../../../../client/public/dashboard'), {
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.js')) {
                res.setHeader('Content-Type', 'application/javascript');
            }
        }
    })
);


export default router;