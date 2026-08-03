import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import urlJoin from 'url-join';
import { delay, tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import crypto from 'crypto';

console.log('[COMFYUI-VIDEO-RELOAD] Module loaded');

function getComfyVideoWorkflows(directories) {
    return fs
        .readdirSync(directories.comfyWorkflowsVideo)
        .filter(file => file[0] !== '.' && file.toLowerCase().endsWith('.json'))
        .sort(Intl.Collator().compare);
}

export const router = express.Router();

router.post('/workflows', async (request, response) => {
    try {
        const data = getComfyVideoWorkflows(request.user.directories);
        return response.send(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/workflow', async (request, response) => {
    try {
        let filePath = path.join(request.user.directories.comfyWorkflowsVideo, sanitize(String(request.body.file_name)));
        if (!fs.existsSync(filePath)) {
            filePath = path.join(request.user.directories.comfyWorkflowsVideo, 'Wan22_I2V_Default_Workflow.json');
        }
        const data = fs.readFileSync(filePath, { encoding: 'utf-8' });
        return response.send(JSON.stringify(data));
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/save-workflow', async (request, response) => {
    try {
        const filePath = path.join(request.user.directories.comfyWorkflowsVideo, sanitize(String(request.body.file_name)));
        writeFileAtomicSync(filePath, request.body.workflow, 'utf8');
        const data = getComfyVideoWorkflows(request.user.directories);
        return response.send(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/delete-workflow', async (request, response) => {
    try {
        const filePath = path.join(request.user.directories.comfyWorkflowsVideo, sanitize(String(request.body.file_name)));
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/rename-workflow', getFileNameValidationFunction('old_name'), getFileNameValidationFunction('new_name'), async (request, response) => {
    try {
        const oldName = sanitize(String(request.body.old_name));
        const newName = sanitize(String(request.body.new_name));

        if (path.extname(oldName).toLowerCase() !== '.json' || path.extname(newName).toLowerCase() !== '.json') {
            return response.status(400).send('Only JSON workflow files are allowed');
        }

        const oldPath = path.join(request.user.directories.comfyWorkflowsVideo, oldName);
        const newPath = path.join(request.user.directories.comfyWorkflowsVideo, newName);

        if (!fs.existsSync(oldPath)) {
            return response.status(404).send('Workflow not found');
        }

        if (fs.existsSync(newPath)) {
            return response.status(409).send('A workflow with that name already exists');
        }

        fs.renameSync(oldPath, newPath);
        return response.sendStatus(204);
    } catch (error) {
        console.error('ComfyUI video workflow rename failed', error);
        return response.sendStatus(500);
    }
});

router.post('/loras', async (request, response) => {
    try {
        if (!request.body.url) {
            console.warn('[ComfyUI-Video] LORAS - no URL provided, returning empty list');
            return response.send([]);
        }
        const url = new URL(urlJoin(request.body.url, '/models/loras'));
        const result = await fetch(url);
        if (!result.ok) {
            throw new Error('Failed to list LoRAs from ComfyUI.');
        }
        const loras = await result.json();
        return response.send(loras);
    } catch (error) {
        console.error('ComfyUI LoRA list error:', error);
        response.status(500).send(error.message);
    }
});

router.post('/unets', async (request, response) => {
    try {
        if (!request.body.url) {
            console.warn('[ComfyUI-Video] UNETs - no URL provided, returning empty list');
            return response.send([]);
        }
        const url = new URL(urlJoin(request.body.url, '/models/diffusion_models'));
        const result = await fetch(url);
        if (!result.ok) {
            throw new Error('Failed to list UNETs from ComfyUI.');
        }
        const models = await result.json();
        const unets = models.filter(m => m.toLowerCase().includes('wan'));
        return response.send(unets);
    } catch (error) {
        console.error('ComfyUI UNET list error:', error);
        response.status(500).send(error.message);
    }
});

router.post('/text-encoders', async (request, response) => {
    try {
        if (!request.body.url) {
            console.warn('[ComfyUI-Video] Text encoders - no URL provided, returning empty list');
            return response.send([]);
        }
        const url = new URL(urlJoin(request.body.url, '/models/text_encoders'));
        const result = await fetch(url);
        if (!result.ok) {
            throw new Error('Failed to list text encoders from ComfyUI.');
        }
        const encoders = await result.json();
        return response.send(encoders);
    } catch (error) {
        console.error('ComfyUI text encoder list error:', error);
        response.status(500).send(error.message);
    }
});

router.post('/vaes', async (request, response) => {
    try {
        if (!request.body.url) {
            console.warn('[ComfyUI-Video] VAEs - no URL provided, returning empty list');
            return response.send([]);
        }
        const url = new URL(urlJoin(request.body.url, '/models/vae'));
        const result = await fetch(url);
        if (!result.ok) {
            throw new Error('Failed to list VAEs from ComfyUI.');
        }
        const vaes = await result.json();
        return response.send(vaes);
    } catch (error) {
        console.error('ComfyUI VAE list error:', error);
        response.status(500).send(error.message);
    }
});

router.post('/upload', async (request, response) => {
    try {
        const { url, image } = request.body;
        if (!url || !image) {
            return response.status(400).send('Missing url or image');
        }

        const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(cleanImage, 'base64');
        const hash = crypto.createHash('md5').update(imageBuffer).digest('hex').slice(0, 8);
        const filename = `wan_i2v_${hash}.png`;

        const uploadUrl = new URL(urlJoin(url, '/upload/image'));
        const formData = new FormData();
        const blob = new Blob([imageBuffer], { type: 'image/png' });
        formData.append('image', blob, filename);

        const result = await fetch(uploadUrl, {
            method: 'POST',
            body: formData,
        });

        if (!result.ok) {
            const text = await result.text();
            throw new Error('Failed to upload image: ' + text);
        }

        const data = await result.json();
        return response.send({ filename: data.name, subfolder: data.subfolder || '' });
    } catch (error) {
        console.error('ComfyUI image upload error:', error);
        response.status(500).send(error.message);
    }
});

router.post('/generate', async (request, response) => {
    let item;
    try {
        const url = new URL(urlJoin(request.body.url, '/prompt'));

        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            if (!response.writableEnded && !item) {
                const interruptUrl = new URL(urlJoin(request.body.url, '/interrupt'));
                fetch(interruptUrl, { method: 'POST' });
            }
        });

        const promptResult = await fetch(url, {
            method: 'POST',
            body: request.body.prompt,
        });
        if (!promptResult.ok) {
            const text = await promptResult.text();
            throw new Error('ComfyUI returned an error.', { cause: tryParse(text) });
        }

        const data = await promptResult.json();
        const id = data.prompt_id;
        const historyUrl = new URL(urlJoin(request.body.url, '/history'));

        while (true) {
            const result = await fetch(historyUrl);
            if (!result.ok) {
                throw new Error('ComfyUI returned an error.');
            }
            const history = await result.json();
            item = history[id];
            if (item) break;
            await delay(500);
        }

        if (item.status.status_str === 'error') {
            const errorMessages = item.status?.messages
                ?.filter(it => it[0] === 'execution_error')
                .map(it => it[1])
                .map(it => `${it.node_type} [${it.node_id}] ${it.exception_type}: ${it.exception_message}`)
                .join('\n') || '';
            throw new Error(`ComfyUI generation did not succeed.\n\n${errorMessages}`.trim());
        }

        let videoInfo = null;
        for (const output of Object.values(item.outputs)) {
            if (output?.ui?.content && Array.isArray(output.ui.content)) {
                videoInfo = output.ui.content[0];
                break;
            }
            if (output?.images && Array.isArray(output.images)) {
                videoInfo = output.images[0];
                break;
            }
        }

        if (!videoInfo) {
            throw new Error('ComfyUI did not return any video outputs.');
        }

        const videoUrl = new URL(urlJoin(request.body.url, '/view'));
        videoUrl.search = `?filename=${videoInfo.filename}&subfolder=${videoInfo.subfolder}&type=${videoInfo.type}`;
        const videoResponse = await fetch(videoUrl);
        if (!videoResponse.ok) {
            throw new Error('Failed to fetch video from ComfyUI.');
        }
        const format = path.extname(videoInfo.filename).slice(1).toLowerCase() || 'mp4';
        const videoBuffer = await videoResponse.arrayBuffer();
        return response.send({ format, data: Buffer.from(videoBuffer).toString('base64') });
    } catch (error) {
        console.error('ComfyUI video error:', error);
        response.status(500).send(error.message);
    }
});
