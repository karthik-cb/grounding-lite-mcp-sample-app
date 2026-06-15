/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { trace } from './utils/logger.js';
// Load environment variables from .env file for server components
import 'dotenv/config';



import { linkPreviewHandler } from './api/previewHandler.js';
import { initChatSession, sendMessageToAI } from './services/conversationalAIService.js';
import bodyParser from 'body-parser';
import { searchPlacesReal } from './services/groundingLiteService.js';
import { getPlaceDetailsReal, getElevationForLocations } from './services/complementaryServices.js';

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * This is the main entry point for the MCP server and the static file server.
 */
async function main() {
  console.log('[start] main() called');
  try {
    // We'll use the PORT environment variable, or 8080 as a default (matching Vite proxy).
    const PORT = parseInt(process.env.PORT || '8080', 10);
    console.log(`[start] Attempting to start server on port ${PORT}...`);

    const app = express();
    // Raise the JSON body limit so base64-encoded image attachments (up to 5,
    // consumed by the Cerebras/Gemma multimodal path) fit in the request body.
    app.use(bodyParser.json({ limit: '25mb' }));

    app.post('/api/init-chat', async (req, res) => {
      console.log('[start] /api/init-chat called');
      try {
        const result = await initChatSession();
        res.json(result);
      } catch (error) {
        console.error('Error in /api/init-chat:', error);
        res.status(500).send({ error: 'Failed to initialize chat session.' });
      }
    });

    // ... (rest of the routes)

    app.post('/api/chat', async (req, res) => {
      // Setup SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const sendEvent = (data: object) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const { message, images } = req.body;
        if (!message) {
          sendEvent({ error: 'Message is required.' });
          res.end();
          return;
        }

        // Optional base64 image data URLs (data:image/png;base64,...). Only the
        // Cerebras/Gemma provider currently consumes these; ignored by Gemini.
        const imageList: string[] | undefined = Array.isArray(images)
          ? images.filter((img: unknown): img is string => typeof img === 'string')
          : undefined;

        const statusCallback = (status: string) => {
          sendEvent({ status });
        };

        const result = await sendMessageToAI(message, statusCallback, imageList);
        sendEvent({ result });

      } catch (error) {
        console.error('Error in /api/chat:', error);
        sendEvent({ error: 'Failed to process chat message.' });
      } finally {
        res.end();
      }
    });

    // API endpoint for server-side geocoding/place search
    app.post('/api/searchPlaces', async (req, res) => {
      try {
        const { query, locationBias } = req.body;
        if (!query) {
          return res.status(400).send({ error: 'Query parameter is required.' });
        }

        // Use the existing server-side searchPlacesReal function (the geocoder)
        const result = await searchPlacesReal(query, locationBias);

        // Return the first place result, which includes location and place_id
        res.json(result);
      } catch (error) {
        console.error('Error in /api/searchPlaces:', error);
        res.status(500).send({ error: 'Failed to perform place search.' });
      }
    });
    // API endpoint for fetching elevation data
    app.post('/api/elevation', async (req, res) => {
      try {
        const { locations } = req.body;
        if (!locations || !Array.isArray(locations) || locations.length === 0) {
          return res.status(400).send({ error: 'Locations array is required.' });
        }

        const result = await getElevationForLocations(locations);

        if (result.error) {
            console.error('Error fetching elevation:', result.error);
            return res.status(500).send({ error: result.error });
        }

        res.json(result);
      } catch (error) {
        console.error('Error in /api/elevation:', error);
        res.status(500).send({ error: 'Failed to retrieve elevation data.' });
      }
    });



    // API endpoint for fetching place details by ID
    app.post('/api/placeDetails', async (req, res) => {
      try {
        const { placeId } = req.body;
        if (!placeId) {
          return res.status(400).send({ error: 'placeId parameter is required.' });
        }

        const result = await getPlaceDetailsReal(placeId);

        if (result.error) {
          console.error(`Error fetching place details for ${placeId}:`, result.error);
          return res.status(500).send({ error: result.error });
        }

        // Return the place object wrapped in the result structure
        res.json(result);
      } catch (error) {
        console.error('Error in /api/placeDetails:', error);
        res.status(500).send({ error: 'Failed to perform place details lookup.' });
      }
    });


    // --- API Routes ---
    app.get('/api/preview', linkPreviewHandler);

    // --- Static File Serving ---
    // path.resolve(__dirname, '..', 'dist') resolves correctly in compiled Node execution (dist/start.js)
    // but incorrectly in ts-node execution. We check if running via ts-node for local dev.
    // Detect if we are running the source .ts file (dev mode) or the compiled .js file (prod mode)
    // When running start.ts via --loader ts-node/esm, __dirname is the project root.
    // When running dist/start.js, __dirname is the dist directory.
    const isDevMode = __filename.endsWith('.ts');

    const staticPath = isDevMode
        ? path.resolve(__dirname, 'dist')
        : path.resolve(__dirname, '..', 'dist');
    app.use('/', express.static(staticPath));
    trace(`[start] Serving static files from: ${staticPath}`);

    // Fallback to serving index.html for all non-API routes, which is common in SPA deployments.
    // This must come after static serving and API routes.
    app.use((req, res, next) => {
      // Fallback only if the path does not start with /api/
      if (req.path.startsWith('/api/')) {
        return next();
      }
      // Serve index.html for all other unmatched routes (SPA history fallback)
      res.sendFile(path.join(staticPath, 'index.html'));
    });

    console.log('[start] Calling app.listen...');
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`[start] HTTP server listening on port ${PORT} (0.0.0.0)`);
      trace(`[start] HTTP server listening on port ${PORT} (0.0.0.0)`);
    });

    server.on('error', (e) => {
      console.error('[start] Server error:', e);
    });


  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();