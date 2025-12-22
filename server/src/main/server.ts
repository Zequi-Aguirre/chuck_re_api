import { ChuckREAPILocalServer } from './chuckREAPILocalServer.ts';
import { EnvConfig } from './config/EnvConfig';

const PORT = process.env.PORT || 8080;

(async () => {
    try {
        // Initialize configuration
        const config = new EnvConfig();

        // Create and setup the server
        const server = await new ChuckREAPILocalServer(config).setup();

        // Start listening using the internally created HTTP server
        const httpServer = server.getHttpServer();
        if (!httpServer) {
            throw new Error("Failed to get HTTP server instance.");
        }

        httpServer.listen(PORT, () => {
            console.log(`Server listening on http://localhost:${PORT}!`);
        });

    } catch (error) {
        console.error('App initialization error:', error);
    }
})();