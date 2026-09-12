import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { AppModule } from './app.module.js';
import { MANAGER_CONFIG } from './config/config.js';
import { originAllowed } from './origin.js';
export async function createApp(overrides = {}, options = {}) {
    const app = await NestFactory.create(AppModule.forRoot(overrides), { logger: options.quiet ? false : ['log', 'warn', 'error'] });
    app.useWebSocketAdapter(new WsAdapter(app));
    app.use(express.json({ limit: '1mb' }));
    const config = app.get(MANAGER_CONFIG);
    if (config.trustedProxies.length)
        app.set('trust proxy', config.trustedProxies);
    app.use('/api', (req, res, next) => {
        const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        if (mutating &&
            !originAllowed(req.headers.origin, req.headers.host, config.publicOrigin)) {
            return res
                .status(403)
                .json({ statusCode: 403, message: 'origin not allowed' });
        }
        if (mutating &&
            req.body !== undefined &&
            (typeof req.body !== 'object' ||
                req.body === null ||
                Array.isArray(req.body))) {
            return res
                .status(400)
                .json({ statusCode: 400, message: 'body must be a JSON object' });
        }
        if (mutating && req.body === undefined)
            req.body = {};
        next();
    });
    if (config.uiDir && fs.existsSync(path.join(config.uiDir, 'index.html'))) {
        app.useStaticAssets(config.uiDir, { index: 'index.html' });
        app.use((req, res, next) => {
            if (req.method === 'GET' &&
                !req.path.startsWith('/api/') &&
                (req.headers.accept ?? '').includes('text/html'))
                return res.sendFile('index.html', { root: config.uiDir });
            next();
        });
    }
    return app;
}
async function bootstrap() {
    const app = await createApp();
    const config = app.get(MANAGER_CONFIG);
    const logger = new Logger('main');
    process.on('uncaughtException', (err) => logger.error(`uncaught exception: ${err.stack ?? err}`));
    process.on('unhandledRejection', (err) => logger.error(`unhandled rejection: ${err?.stack ?? err}`));
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.once(sig, () => {
            logger.log(`${sig} received, shutting down (agents keep running in the daemon)`);
            setTimeout(() => process.exit(0), 5000).unref();
            void app.close().finally(() => process.exit(0));
        });
    }
    await app.listen(config.port, config.host);
    logger.log(`agent-manager listening on http://${config.host}:${config.port}/`);
}
if (process.argv[1] &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    await bootstrap();
}
//# sourceMappingURL=main.js.map