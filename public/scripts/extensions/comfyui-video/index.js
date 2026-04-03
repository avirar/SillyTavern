import {
    appendMediaToMessage,
    chat_metadata,
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../script.js';
import {
    extension_settings,
    getApiUrl,
    getContext,
    renderExtensionTemplateAsync,
} from '../../extensions.js';
import { getBase64Async, saveBase64AsFile } from '../../utils.js';
import { getMessageTimeStamp } from '../../RossAscends-mods.js';
import { debounce_timeout, MEDIA_DISPLAY, MEDIA_TYPE, MEDIA_SOURCE, SCROLL_BEHAVIOR } from '../../constants.js';
import { getMultimodalCaption } from '../shared.js';
export { MODULE_NAME };

const MODULE_NAME = 'comfyui-video';

async function getComfyUrl() {
    const settings = extension_settings[MODULE_NAME] || {};
    console.log('[ComfyUI-Video] getComfyUrl - settings:', settings);
    if (settings.url) {
        console.log('[ComfyUI-Video] getComfyUrl - using settings.url:', settings.url);
        return settings.url;
    }
    const sdSettings = extension_settings.sd || {};
    const url = sdSettings.comfy_url || 'http://192.168.1.202:7801/ComfyBackendDirect';
    console.log('[ComfyUI-Video] getComfyUrl - fallback to sd.comfy_url or default:', url);
    return url;
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json();
}

async function loadModelsList() {
    const url = await getComfyUrl();
    console.log('[ComfyUI-Video] loadModelsList - url:', url);
    if (!url) {
        console.warn('[ComfyUI-Video] No ComfyUI URL configured, returning empty model lists');
        return { loras: [], vaes: [], textEncoders: [], unets: [] };
    }
    try {
        const [loras, vaes] = await Promise.all([
            fetchJson('/api/comfyui-video/loras', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ url }) }),
            fetchJson('/api/comfyui-video/vaes', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ url }) }),
        ]);
        const unets = await fetchJson('/api/comfyui-video/unets', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ url }) });
        const textEncoders = await fetchJson('/api/comfyui-video/text-encoders', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ url }) });
        return { loras: loras || [], vaes: vaes || [], textEncoders: textEncoders || [], unets: unets || [] };
    } catch (error) {
        console.error('[ComfyUI-Video] Error loading models:', error);
        return { loras: [], vaes: [], textEncoders: [], unets: [] };
    }
}

function buildWan22I2VWorkflow(imageFilename, prompt, negativePrompt, settings) {
    const seed = settings.seed < 0 ? Math.floor(Math.random() * 2147483647) : (settings.seed ?? 0);
    const guidance = settings.guidance ?? 6.0;
    const shift = settings.shift ?? 8.0;
    const fps = settings.fps ?? 24;
    const width = settings.width ?? 768;
    const height = settings.height ?? 768;
    const steps = settings.steps ?? 10;
    const useSageAttn = settings.useSageAttn ?? true;
    const sageAttnMode = settings.sageAttnMode ?? 'auto';
    const splitRatio = (settings.splitPoint ?? 50) / 100;
    const splitStep = Math.max(1, Math.round(steps * splitRatio));

    // Sampler and scheduler settings
    const samplerHigh = settings.samplerHigh ?? 'euler_ancestral';
    const samplerLow = settings.samplerLow ?? 'euler_ancestral';
    const scheduler = settings.scheduler ?? 'normal';

    // Stepped CFG and LoRA settings
    const cfgHigh = settings.cfgHigh ?? 2.0;
    const cfgLow = settings.cfgLow ?? 1.0;
    const useLora = settings.useLora ?? true;

    // Add trigger word to prompt if LoRA enabled
    const triggerWord = useLora ? "nsfwsk " : "";
    const posPrompt = triggerWord + (prompt?.trim() || 'high quality, smooth motion, cinematic');
    const negPrompt = negativePrompt?.trim() || 'blurry, distorted, low quality, artifacts';

    const unetHigh = 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors';
    const unetLow = 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors';
    const textEncoder = 'umt5_xxl_fp8_e4m3fn_scaled.safetensors';
    const vae = 'Wan2_1_VAE_bf16.safetensors';

    // LoRA settings - only add LoRA nodes if enabled
    const loraNameHigh = 'NSFW-22-H-e8.safetensors';
    const loraNameLow = 'NSFW-22-L-e8.safetensors';
    const loraStrengthHigh = 0.9;
    const loraStrengthLow = 0.9;

    const nodes = {};

    nodes["1"] = { "class_type": "LoadImage", "inputs": { "image": imageFilename } };
    nodes["2"] = {
        "class_type": "CLIPLoader",
        "inputs": {
            "clip_name": textEncoder,
            "type": "wan",
            "device": "default",
        }
    };
    nodes["3"] = { "class_type": "CLIPTextEncode", "inputs": { "text": posPrompt, "clip": ["2", 0] } };
    nodes["4"] = { "class_type": "CLIPTextEncode", "inputs": { "text": negPrompt, "clip": ["2", 0] } };
    nodes["5"] = { "class_type": "VAELoader", "inputs": { "vae_name": vae } };
    nodes["6"] = {
        "class_type": "WanImageToVideo",
        "inputs": {
            "positive": ["3", 0],
            "negative": ["4", 0],
            "vae": ["5", 0],
            "width": width,
            "height": height,
            "length": 81,
            "batch_size": 1,
            "start_image": ["1", 0],
        }
    };
    nodes["7"] = { "class_type": "UNETLoader", "inputs": { "unet_name": unetHigh, "weight_dtype": "default" } };
    nodes["8"] = { "class_type": "UNETLoader", "inputs": { "unet_name": unetLow, "weight_dtype": "default" } };

    // LoRA nodes - inserted between UNETLoader and attention/sampling
    // Using LoraLoaderModelOnly (standard ComfyUI node) - only modifies MODEL, not CLIP
    if (useLora) {
        nodes["17"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": ["7", 0],
                "lora_name": loraNameHigh,
                "strength_model": loraStrengthHigh
            }
        };
        nodes["18"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": ["8", 0],
                "lora_name": loraNameLow,
                "strength_model": loraStrengthLow
            }
        };
    }

    if (useSageAttn) {
        nodes["9"] = {
            "class_type": "PathchSageAttentionKJ",
            "inputs": {
                "model": useLora ? ["17", 0] : ["7", 0],
                "sage_attention": sageAttnMode,
            }
        };
        nodes["10"] = {
            "class_type": "PathchSageAttentionKJ",
            "inputs": {
                "model": useLora ? ["18", 0] : ["8", 0],
                "sage_attention": sageAttnMode,
            }
        };
        nodes["11"] = { "class_type": "ModelSamplingSD3", "inputs": { "model": ["9", 0], "shift": shift } };
        nodes["12"] = { "class_type": "ModelSamplingSD3", "inputs": { "model": ["10", 0], "shift": shift } };
    } else {
        nodes["9"] = { "class_type": "ModelSamplingSD3", "inputs": { "model": useLora ? ["17", 0] : ["7", 0], "shift": shift } };
        nodes["10"] = { "class_type": "ModelSamplingSD3", "inputs": { "model": useLora ? ["18", 0] : ["8", 0], "shift": shift } };
    }

    nodes["13"] = {
        "class_type": "KSamplerAdvanced",
        "inputs": {
            "model": ["9", 0],
            "add_noise": "enable",
            "noise_seed": seed,
            "steps": steps,
            "cfg": cfgHigh,
            "sampler_name": samplerHigh,
            "scheduler": scheduler,
            "positive": ["6", 0],
            "negative": ["6", 1],
            "latent_image": ["6", 2],
            "start_at_step": 0,
            "end_at_step": splitStep,
            "return_with_leftover_noise": "enable",
        }
    };
    nodes["14"] = {
        "class_type": "KSamplerAdvanced",
        "inputs": {
            "model": ["10", 0],
            "add_noise": "disable",
            "noise_seed": seed,
            "steps": steps,
            "cfg": cfgLow,
            "sampler_name": samplerLow,
            "scheduler": scheduler,
            "positive": ["6", 0],
            "negative": ["6", 1],
            "latent_image": ["13", 0],
            "start_at_step": splitStep,
            "end_at_step": 10000,
            "return_with_leftover_noise": "disable",
        }
    };
    nodes["15"] = { "class_type": "VAEDecode", "inputs": { "samples": ["14", 0], "vae": ["5", 0] } };
    nodes["16"] = {
        "class_type": "SaveWEBM",
        "inputs": {
            "images": ["15", 0],
            "filename_prefix": "ComfyUI/video",
            "codec": "vp9",
            "fps": fps,
            "crf": 16,
        }
    };

    return nodes;
}

function migrateSettings() {
    const s = extension_settings[MODULE_NAME];
    if (!s) {
        extension_settings[MODULE_NAME] = {};
    }
    const sdSettings = extension_settings.sd || {};
    if (!s.url) {
        s.url = sdSettings.comfy_url || 'http://192.168.1.202:7801/ComfyBackendDirect';
        console.log('[ComfyUI-Video] migrateSettings - set URL to:', s.url);
        saveSettingsDebounced();
    }
    if (s.unetHigh === undefined) {
        s.unetHigh = '';
    }
    if (s.unetLow === undefined) {
        s.unetLow = '';
    }
    if (s.textEncoder === undefined) {
        s.textEncoder = '';
    }
    if (s.shift === undefined) {
        s.shift = 8.0;
    }
    if (s.steps === undefined) {
        s.steps = 10;
    }
    if (s.splitPoint === undefined) {
        s.splitPoint = 50;
    }
    if (s.guidance === undefined) {
        s.guidance = 6.0;
    }
    if (s.useEndFrame === undefined) {
        s.useEndFrame = false;
    }
    if (s.useSageAttn === undefined) {
        s.useSageAttn = true;
    }
    if (s.sageAttnMode === undefined) {
        s.sageAttnMode = 'auto';
    }
    if (s.seed === undefined) {
        s.seed = -1;
    }
    if (s.samplerHigh === undefined) {
        s.samplerHigh = 'euler_ancestral';
    }
    if (s.samplerLow === undefined) {
        s.samplerLow = 'euler_ancestral';
    }
    if (s.scheduler === undefined) {
        s.scheduler = 'normal';
    }
    if (s.cfgHigh === undefined) {
        s.cfgHigh = 2.0;
    }
    if (s.cfgLow === undefined) {
        s.cfgLow = 1.0;
    }
    if (s.useLora === undefined) {
        s.useLora = true;
    }
}

async function generateVideo(imageBase64, prompt, negativePrompt, settings) {
    const url = await getComfyUrl();
    if (!url) throw new Error('ComfyUI URL not configured.');

    const uploadResponse = await fetch('/api/comfyui-video/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url, image: imageBase64 }),
    });
    if (!uploadResponse.ok) {
        throw new Error('Failed to upload image: ' + await uploadResponse.text());
    }
    const { filename } = await uploadResponse.json();

    const workflow = buildWan22I2VWorkflow(filename, prompt, negativePrompt, settings);

    const response = await fetch('/api/comfyui-video/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url, prompt: JSON.stringify({ prompt: workflow }) }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || 'Video generation failed.');
    }

    const data = await response.json();
    if (!data.data) throw new Error('No video returned from generation.');
    return data;
}

jQuery(async function () {
    migrateSettings();

    async function addSettings() {
        const container = $('#comfyui-video-container');
        if (!container.length) return;
        const html = await renderExtensionTemplateAsync('comfyui-video', 'settings');
        container.append(html);
        await bindSettings();
    }

    async function bindSettings() {
        const settings = extension_settings[MODULE_NAME] || {};

        $('#cv_randomize_seed').on('click', () => {
            $('#cv_seed').val(Math.floor(Math.random() * 2147483647));
        });

        $('#cv_refresh_models').on('click', async () => {
            toastr.info('Refreshing model lists...', 'ComfyUI Video');
            const models = await loadModelsList();
            populateModelDropdowns(models);
            toastr.success('Models refreshed.', 'ComfyUI Video');
        });

        function populateModelDropdowns(models) {
            const unetHighSelect = $('#cv_unet_high');
            const unetLowSelect = $('#cv_unet_low');
            const textEncSelect = $('#cv_text_encoder');
            const vaeSelect = $('#cv_vae');
            const loraSelect = $('#cv_lora');

            unetHighSelect.empty();
            unetLowSelect.empty();
            textEncSelect.empty();
            vaeSelect.empty();
            loraSelect.empty();

            unetHighSelect.append($('<option value="">Auto-detect</option>'));
            unetLowSelect.append($('<option value="">Auto-detect</option>'));
            textEncSelect.append($('<option value="">Auto (UMT5 preferred)</option>'));
            vaeSelect.append($('<option value="">Default</option>'));
            loraSelect.append($('<option value="">None</option>'));

            if (models.unets && models.unets.length > 0) {
                models.unets.forEach(modelName => {
                    const option = $(`<option value="${modelName}">${modelName}</option>`);
                    unetHighSelect.append(option);
                    unetLowSelect.append(option.clone());
                });
            }

            if (models.textEncoders && models.textEncoders.length > 0) {
                models.textEncoders.forEach(encoderName => {
                    textEncSelect.append($(`<option value="${encoderName}">${encoderName}</option>`));
                });
            }

            if (models.vaes && models.vaes.length > 0) {
                models.vaes.forEach(vaeName => {
                    vaeSelect.append($(`<option value="${vaeName}">${vaeName}</option>`));
                });
            }

            if (models.loras && models.loras.length > 0) {
                models.loras.forEach(loraName => {
                    loraSelect.append($(`<option value="${loraName}">${loraName}</option>`));
                });
            }

            unetHighSelect.val(settings.unetHigh || '');
            unetLowSelect.val(settings.unetLow || '');
            textEncSelect.val(settings.textEncoder || '');
            vaeSelect.val(settings.vae || '');
            loraSelect.val(settings.lora || '');

            unetHighSelect.on('change', function() {
                settings.unetHigh = $(this).val();
                saveSettingsDebounced();
            });

            unetLowSelect.on('change', function() {
                settings.unetLow = $(this).val();
                saveSettingsDebounced();
            });

            textEncSelect.on('change', function() {
                settings.textEncoder = $(this).val();
                saveSettingsDebounced();
            });

            vaeSelect.on('change', function() {
                settings.vae = $(this).val();
                saveSettingsDebounced();
            });

            loraSelect.on('change', function() {
                settings.lora = $(this).val();
                saveSettingsDebounced();
            });

            $('#cv_seed').on('input', function() {
                settings.seed = Number($(this).val());
                saveSettingsDebounced();
            });

            $('#cv_use_end_frame').prop('checked', !!settings.useEndFrame).on('input', function() {
                settings.useEndFrame = !!$(this).prop('checked');
                saveSettingsDebounced();
            });

            $('#cv_use_sageattn').prop('checked', !!settings.useSageAttn).on('input', function() {
                settings.useSageAttn = !!$(this).prop('checked');
                saveSettingsDebounced();
            });

            $('#cv_sage_attn_mode').val(settings.sageAttnMode || 'auto').on('change', function() {
                settings.sageAttnMode = $(this).val();
                saveSettingsDebounced();
            });

            $('#cv_resolution').val(settings.resolution || '768,768').on('change', function() {
                const [w, h] = $(this).val().split(',').map(Number);
                settings.resolution = $(this).val();
                settings.width = w;
                settings.height = h;
                saveSettingsDebounced();
            });

            $('#cv_steps').val(settings.steps ?? 10).on('input', function() {
                settings.steps = Number($(this).val());
                saveSettingsDebounced();
            });

            $('#cv_split_point').val(settings.splitPoint ?? 50).on('input', function() {
                const pct = Number($(this).val());
                settings.splitPoint = pct;
                const steps = settings.steps ?? 10;
                const high = Math.max(1, Math.round(steps * pct / 100));
                $('#cv_split_display').text(`${pct}% (${high} high / ${steps - high} low on ${steps} steps)`);
                saveSettingsDebounced();
            }).trigger('input');

            $('#cv_shift').val(settings.shift ?? 8.0).on('input', function() {
                settings.shift = Number($(this).val());
                saveSettingsDebounced();
            });

            $('#cv_guidance').val(settings.guidance ?? 6.0).on('input', function() {
                settings.guidance = Number($(this).val());
                saveSettingsDebounced();
            });

            $('#cv_cfg_high').val(settings.cfgHigh ?? 2.0).on('input', function() {
                settings.cfgHigh = Number($(this).val());
                saveSettingsDebounced();
            });

            $('#cv_cfg_low').val(settings.cfgLow ?? 1.0).on('input', function() {
                settings.cfgLow = Number($(this).val());
                saveSettingsDebounced();
            });

            $('#cv_use_lora').prop('checked', settings.useLora !== false).on('change', function() {
                settings.useLora = $(this).is(':checked');
                saveSettingsDebounced();
            });

            $('#cv_fps').val(settings.fps ?? 24).on('change', function() {
                settings.fps = Number($(this).val());
                saveSettingsDebounced();
            });

            // Sampler and scheduler settings
            $('#cv_sampler_high').val(settings.samplerHigh || 'euler_ancestral').on('change', function() {
                settings.samplerHigh = $(this).val();
                saveSettingsDebounced();
            });

            $('#cv_sampler_low').val(settings.samplerLow || 'euler_ancestral').on('change', function() {
                settings.samplerLow = $(this).val();
                saveSettingsDebounced();
            });

            $('#cv_scheduler').val(settings.scheduler || 'normal').on('change', function() {
                settings.scheduler = $(this).val();
                saveSettingsDebounced();
            });
        }

        const models = await loadModelsList();
        populateModelDropdowns(models);
    }

    $(document).on('click', '.mes_img_vid', async function () {
        const messageBlock = $(this).closest('.mes');
        const mediaContainer = $(this).closest('.mes_media_container');
        const messageMedia = mediaContainer.find('.mes_img, .mes_video');
        if (messageMedia.hasClass('generating')) return;
        messageMedia.addClass('generating');

        try {
            const messageId = Number(messageBlock.attr('mesid'));
            const mediaIndex = Number(mediaContainer.attr('data-index'));
            const data = getContext().chat[messageId];
            if (!data?.extra?.media?.[mediaIndex]) throw new Error('No image found at this position.');

            const media = data.extra.media[mediaIndex];
            const imageResponse = await fetch(media.url);
            const imageBlob = await imageResponse.blob();
            const imageBase64 = await getBase64Async(imageBlob);
            const settings = extension_settings[MODULE_NAME] || {};

            let prompt = '';
            let negativePrompt = '';

            if (media.source === MEDIA_SOURCE.GENERATED) {
                prompt = media.title || data.extra?.title || '';
                negativePrompt = media.negative || data.extra?.negative || '';
                console.log('[ComfyUI-Video] Using stored prompt for generated image:', prompt.slice(0, 80));
            } else {
                try {
                    prompt = await getMultimodalCaption(imageBase64, 'Describe this image concisely for video generation prompt:');
                } catch (e) {
                    console.warn('[ComfyUI-Video] Caption failed, using default:', e);
                }
            }

            const finalPrompt = settings.prompt || prompt || 'high quality, smooth motion, cinematic';
            const finalNegative = settings.negativePrompt || negativePrompt || 'blurry, distorted, low quality, artifacts';

            const result = await generateVideo(imageBase64, finalPrompt, finalNegative, settings);

            const videoFilename = `comfyui_video_${Date.now()}`;
            const videoPath = await saveBase64AsFile(result.data, videoFilename, videoFilename, result.format);
            const videoAttachment = {
                url: videoPath,
                type: MEDIA_TYPE.VIDEO,
                source: MEDIA_SOURCE.GENERATED,
                title: finalPrompt || 'ComfyUI video',
                negative: finalNegative || '',
            };
            if (!Array.isArray(data.extra.media)) {
                data.extra.media = [];
            }
            data.extra.media.push(videoAttachment);
            data.extra.media_index = data.extra.media.length - 1;
            data.extra.inline_image = false;
            appendMediaToMessage(data, messageBlock, SCROLL_BEHAVIOR.KEEP);
            try {
                await getContext().saveChat();
            } catch (saveError) {
                console.warn('Failed to save chat:', saveError);
            }
        } catch (e) {
            console.error('Video generation failed', e);
            toastr.error(e.message || 'Unknown error', 'Video Generation Failed');
        } finally {
            messageMedia.removeClass('generating');
        }
    });

    await addSettings();
});