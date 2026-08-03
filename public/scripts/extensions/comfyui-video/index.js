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
import { getBase64Async, saveBase64AsFile, delay } from '../../utils.js';
import { getMessageTimeStamp } from '../../RossAscends-mods.js';
import { debounce_timeout, MEDIA_DISPLAY, MEDIA_TYPE, MEDIA_SOURCE, SCROLL_BEHAVIOR } from '../../constants.js';
import { getMultimodalCaption } from '../shared.js';
import { callGenericPopup, Popup, POPUP_TYPE } from '../../popup.js';
export { MODULE_NAME };

const MODULE_NAME = 'comfyui-video';

const DEFAULT_WORKFLOW = 'Wan22_I2V_Default_Workflow.json';

async function getComfyUrl() {
    const settings = extension_settings[MODULE_NAME] || {};
    if (settings.url) {
        return settings.url;
    }
    const sdSettings = extension_settings.sd || {};
    const url = sdSettings.comfy_url || 'http://192.168.1.202:7801/ComfyBackendDirect';
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
    if (!url) {
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

async function loadComfyWorkflows() {
    try {
        const result = await fetch('/api/comfyui-video/workflows', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!result.ok) {
            throw new Error('Failed to list workflows.');
        }
        const workflows = await result.json();
        const settings = extension_settings[MODULE_NAME] || {};
        const select = $('#cv_workflow');
        select.empty();
        for (const workflow of workflows) {
            const option = document.createElement('option');
            option.innerText = workflow;
            option.value = workflow;
            option.selected = workflow === (settings.workflow || DEFAULT_WORKFLOW);
            select.append(option);
        }
        settings.workflow = select.val() || DEFAULT_WORKFLOW;
    } catch (error) {
        console.error(`[ComfyUI-Video] Could not load workflows: ${error.message}`);
    }
}

async function onComfyOpenWorkflowEditorClick() {
    const settings = extension_settings[MODULE_NAME] || {};
    let workflow = await (await fetch('/api/comfyui-video/workflow', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            file_name: settings.workflow,
        }),
    })).json();

    const editorHtml = $(await $.get('scripts/extensions/comfyui-video/comfyWorkflowEditor.html'));
    const saveValue = (/** @type {Popup} */ _popup) => {
        workflow = $('#cv_comfy_workflow_editor_workflow').val().toString();
        return true;
    };
    const popup = new Popup(editorHtml, POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel', wide: true, large: true, onClosing: saveValue });
    const popupResult = popup.show();

    const checkPlaceholders = () => {
        workflow = $('#cv_comfy_workflow_editor_workflow').val().toString();
        $('.cv_comfy_workflow_editor_placeholder_list > li[data-placeholder]').each(function () {
            const key = this.getAttribute('data-placeholder');
            const found = workflow.search(`%${key}%`) !== -1;
            this.classList[found ? 'remove' : 'add']('cv_comfy_workflow_editor_not_found');
        });
    };

    $('#cv_comfy_workflow_editor_name').text(settings.workflow);
    $('#cv_comfy_workflow_editor_workflow').val(workflow);

    const addPlaceholderDom = (placeholder) => {
        const el = $(`
            <li class="cv_comfy_workflow_editor_not_found" data-placeholder="${placeholder.find}">
                <span class="cv_comfy_workflow_editor_custom_remove" title="Remove custom placeholder">\u2298</span>
                <span class="cv_comfy_workflow_editor_custom_final">"%${placeholder.find}%"</span><br>
                <input placeholder="find" title="find" type="text" class="text_pole cv_comfy_workflow_editor_custom_find" value=""><br>
                <input placeholder="replace" title="replace" type="text" class="text_pole cv_comfy_workflow_editor_custom_replace">
            </li>
        `);
        $('#cv_comfy_workflow_editor_placeholder_list_custom').append(el);
        el.find('.cv_comfy_workflow_editor_custom_find').val(placeholder.find);
        el.find('.cv_comfy_workflow_editor_custom_find').on('input', function () {
            if (!(this instanceof HTMLInputElement)) return;
            placeholder.find = this.value;
            el.find('.cv_comfy_workflow_editor_custom_final').text(`"%${this.value}%"`);
            el.attr('data-placeholder', `${this.value}`);
            checkPlaceholders();
            saveSettingsDebounced();
        });
        el.find('.cv_comfy_workflow_editor_custom_replace').val(placeholder.replace);
        el.find('.cv_comfy_workflow_editor_custom_replace').on('input', function () {
            if (!(this instanceof HTMLInputElement)) return;
            placeholder.replace = this.value;
            saveSettingsDebounced();
        });
        el.find('.cv_comfy_workflow_editor_custom_remove').on('click', () => {
            el.remove();
            const phs = extension_settings[MODULE_NAME].comfyPlaceholders;
            const idx = phs.indexOf(placeholder);
            if (idx !== -1) phs.splice(idx, 1);
            saveSettingsDebounced();
        });
    };

    $('#cv_comfy_workflow_editor_placeholder_add').on('click', () => {
        if (!extension_settings[MODULE_NAME].comfyPlaceholders) {
            extension_settings[MODULE_NAME].comfyPlaceholders = [];
        }
        const placeholder = { find: '', replace: '' };
        extension_settings[MODULE_NAME].comfyPlaceholders.push(placeholder);
        addPlaceholderDom(placeholder);
        saveSettingsDebounced();
    });

    (extension_settings[MODULE_NAME].comfyPlaceholders ?? []).forEach(placeholder => {
        addPlaceholderDom(placeholder);
    });

    checkPlaceholders();
    $('#cv_comfy_workflow_editor_workflow').on('input', checkPlaceholders);

    if (await popupResult) {
        const response = await fetch('/api/comfyui-video/save-workflow', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                file_name: extension_settings[MODULE_NAME].workflow,
                workflow: workflow,
            }),
        });
        if (!response.ok) {
            const text = await response.text();
            toastr.error(`Failed to save workflow.\n\n${text}`);
        }
    }
}

async function onComfyNewWorkflowClick() {
    let name = await callGenericPopup('Workflow name:', POPUP_TYPE.INPUT);
    if (!name) return;
    if (!String(name).toLowerCase().endsWith('.json')) {
        name += '.json';
    }
    extension_settings[MODULE_NAME].workflow = name;
    const response = await fetch('/api/comfyui-video/save-workflow', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            file_name: name,
            workflow: '',
        }),
    });
    if (!response.ok) {
        const text = await response.text();
        toastr.error(`Failed to save workflow.\n\n${text}`);
    }
    saveSettingsDebounced();
    await loadComfyWorkflows();
    await delay(200);
    await onComfyOpenWorkflowEditorClick();
}

async function onComfyDeleteWorkflowClick() {
    const confirm = await callGenericPopup('Delete the workflow? This action is irreversible.', POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' });
    if (!confirm) return;
    const response = await fetch('/api/comfyui-video/delete-workflow', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            file_name: extension_settings[MODULE_NAME].workflow,
        }),
    });
    if (!response.ok) {
        const text = await response.text();
        toastr.error(`Failed to delete workflow.\n\n${text}`);
    }
    extension_settings[MODULE_NAME].workflow = DEFAULT_WORKFLOW;
    saveSettingsDebounced();
    await loadComfyWorkflows();
}

async function onComfyRenameWorkflowClick() {
    const oldName = extension_settings[MODULE_NAME].workflow;
    if (!oldName) return;

    let newName = await callGenericPopup('Enter new workflow name:', POPUP_TYPE.INPUT, oldName);
    if (!newName) return;

    newName = String(newName).trim();
    if (!newName.toLowerCase().endsWith('.json')) {
        newName += '.json';
    }
    if (newName === oldName) return;

    const existingWorkflow = Array
        .from(document.querySelectorAll('#cv_workflow option'))
        .find(opt => opt instanceof HTMLOptionElement && opt.value === newName);

    if (existingWorkflow) {
        toastr.warning('A workflow with that name already exists');
        return;
    }

    const response = await fetch('/api/comfyui-video/rename-workflow', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            old_name: oldName,
            new_name: newName,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        toastr.error(`Failed to rename workflow.\n\n${text}`);
        return;
    }

    extension_settings[MODULE_NAME].workflow = newName;
    saveSettingsDebounced();
    await loadComfyWorkflows();
}

function migrateSettings() {
    const s = extension_settings[MODULE_NAME];
    if (!s) {
        extension_settings[MODULE_NAME] = {};
    }
    const sdSettings = extension_settings.sd || {};
    if (!s.url) {
        s.url = sdSettings.comfy_url || 'http://192.168.1.202:7801/ComfyBackendDirect';
        saveSettingsDebounced();
    }
    if (s.workflow === undefined) {
        s.workflow = DEFAULT_WORKFLOW;
    }
    if (s.comfyPlaceholders === undefined) {
        s.comfyPlaceholders = [];
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
    if (s.fps === undefined) {
        s.fps = 16;
    }
    if (s.duration === undefined) {
        s.duration = 5;
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
        s.useLora = false;
    }
    if (s.loraWeight === undefined) {
        s.loraWeight = 0.9;
    }
    if (s.loraHigh === undefined) {
        s.loraHigh = '';
    }
    if (s.loraLow === undefined) {
        s.loraLow = '';
    }
    if (s.promptPrefix === undefined) {
        s.promptPrefix = '';
    }
    if (s.sendImage === undefined) {
        s.sendImage = true;
    }
}

/**
 * Computes a MiniMax H3-valid frame length (frames = 1 mod 17 on the model's
 * 17-per-block grid, rounded up) from a requested duration in seconds at 24fps.
 * @param {number} duration Duration in seconds.
 * @param {number} fps Frames per second.
 * @returns {number} Grid-valid frame count.
 */
function getH3VideoLength(duration, fps) {
    const frames = Math.max(5, Math.round(duration * fps));
    return frames + ((5 - (frames % 17) + 17) % 17);
}

/**
 * Removes the LoadImage node and any first/last-frame conditioning from an
 * API-format workflow string, so it runs as pure text-to-video. Nodes of other
 * model types that consumed the removed image are cleaned up as well.
 * @param {string} workflow Serialized API-format workflow.
 * @returns {string} Serialized workflow without image-to-video inputs.
 */
function stripFirstFrame(workflow) {
    const graph = JSON.parse(workflow);
    for (const [id, node] of Object.entries(graph)) {
        if (node.class_type === 'LoadImage') {
            delete graph[id];
        }
    }
    const refsValid = (ref) => Array.isArray(ref) && graph[ref[0]];
    for (const [id, node] of Object.entries(graph)) {
        if (!node.inputs) continue;
        if (node.class_type === 'MiniMaxH3ImageToVideo') {
            delete node.inputs.first_frame;
            delete node.inputs.last_frame;
        }
        for (const key of Object.keys(node.inputs)) {
            if (Array.isArray(node.inputs[key]) && !refsValid(node.inputs[key])) {
                delete node.inputs[key];
            }
        }
    }
    return JSON.stringify(graph);
}

async function generateVideo(imageBase64, prompt, negativePrompt, settings) {
    const url = await getComfyUrl();
    if (!url) throw new Error('ComfyUI URL not configured.');

    const sendImage = settings.sendImage ?? true;
    let filename = null;

    if (sendImage) {
        const uploadResponse = await fetch('/api/comfyui-video/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ url, image: imageBase64 }),
        });
        if (!uploadResponse.ok) {
            throw new Error('Failed to upload image: ' + await uploadResponse.text());
        }
        ({ filename } = await uploadResponse.json());
    }

    const workflowResponse = await fetch('/api/comfyui-video/workflow', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ file_name: settings.workflow || DEFAULT_WORKFLOW }),
    });
    if (!workflowResponse.ok) {
        throw new Error('Failed to load workflow: ' + await workflowResponse.text());
    }
    let workflow = await workflowResponse.json();

    const seed = settings.seed < 0 ? Math.floor(Math.random() * 2147483647) : (settings.seed ?? 0);
    const fps = settings.fps ?? 16;
    const duration = settings.duration ?? 5;
    const length = (duration * fps) + 1;
    const width = settings.width ?? 768;
    const height = settings.height ?? 768;
    const steps = settings.steps ?? 10;
    const splitRatio = (settings.splitPoint ?? 50) / 100;
    const splitStep = Math.max(1, Math.round(steps * splitRatio));
    const guidance = settings.guidance ?? 6.0;
    const shift = settings.shift ?? 8.0;
    const cfgHigh = settings.cfgHigh ?? 2.0;
    const cfgLow = settings.cfgLow ?? 1.0;
    const useSageAttn = settings.useSageAttn ?? true;
    const sageAttnMode = settings.sageAttnMode ?? 'auto';
    const samplerHigh = settings.samplerHigh ?? 'euler_ancestral';
    const samplerLow = settings.samplerLow ?? 'euler_ancestral';
    const scheduler = settings.scheduler ?? 'normal';
    const useLora = settings.useLora ?? false;
    const loraWeight = settings.loraWeight ?? 0.9;
    const unetHigh = settings.unetHigh || 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors';
    const unetLow = settings.unetLow || 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors';
    const textEncoder = settings.textEncoder || 'umt5_xxl_fp8_e4m3fn_scaled.safetensors';
    const vae = settings.vae || 'Wan2_1_VAE_bf16.safetensors';
    const loraHigh = settings.loraHigh || '';
    const loraLow = settings.loraLow || '';

    workflow = workflow.replaceAll('"%image%"', JSON.stringify(filename || ''));
    workflow = workflow.replaceAll('"%prompt%"', JSON.stringify(prompt));
    workflow = workflow.replaceAll('"%negative_prompt%"', JSON.stringify(negativePrompt));
    workflow = workflow.replaceAll('"%text_encoder%"', JSON.stringify(textEncoder));
    workflow = workflow.replaceAll('"%vae%"', JSON.stringify(vae));
    workflow = workflow.replaceAll('"%unet_high%"', JSON.stringify(unetHigh));
    workflow = workflow.replaceAll('"%unet_low%"', JSON.stringify(unetLow));
    workflow = workflow.replaceAll('"%sampler_high%"', JSON.stringify(samplerHigh));
    workflow = workflow.replaceAll('"%sampler_low%"', JSON.stringify(samplerLow));
    workflow = workflow.replaceAll('"%scheduler%"', JSON.stringify(scheduler));
    workflow = workflow.replaceAll('"%sage_attn_mode%"', JSON.stringify(sageAttnMode));
    workflow = workflow.replaceAll('"%lora_high%"', JSON.stringify(loraHigh));
    workflow = workflow.replaceAll('"%lora_low%"', JSON.stringify(loraLow));
    workflow = workflow.replaceAll('%seed%', JSON.stringify(seed));
    workflow = workflow.replaceAll('%width%', JSON.stringify(width));
    workflow = workflow.replaceAll('%height%', JSON.stringify(height));
    workflow = workflow.replaceAll('%length%', JSON.stringify(length));
    workflow = workflow.replaceAll('%h3_length%', JSON.stringify(getH3VideoLength(duration, fps)));
    workflow = workflow.replaceAll('%steps%', JSON.stringify(steps));
    workflow = workflow.replaceAll('%split_step%', JSON.stringify(splitStep));
    workflow = workflow.replaceAll('%guidance%', JSON.stringify(guidance));
    workflow = workflow.replaceAll('%shift%', JSON.stringify(shift));
    workflow = workflow.replaceAll('%cfg_high%', JSON.stringify(cfgHigh));
    workflow = workflow.replaceAll('%cfg_low%', JSON.stringify(cfgLow));
    workflow = workflow.replaceAll('%fps%', JSON.stringify(fps));
    workflow = workflow.replaceAll('%lora_weight%', JSON.stringify(loraWeight));

    (settings.comfyPlaceholders ?? []).forEach(ph => {
        workflow = workflow.replaceAll(`"%${ph.find}%"`, JSON.stringify(ph.replace));
        workflow = workflow.replaceAll(`%${ph.find}%`, JSON.stringify(ph.replace));
    });

    if (!sendImage) {
        workflow = stripFirstFrame(workflow);
    }

    console.log('[ComfyUI-Video] Final workflow:', workflow);

    const response = await fetch('/api/comfyui-video/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url, prompt: JSON.stringify({ prompt: JSON.parse(workflow) }) }),
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

        await loadComfyWorkflows();

        $('#cv_comfy_url').val(settings.url || '').on('input', function () {
            settings.url = $(this).val();
            saveSettingsDebounced();
        });

        $('#cv_workflow').on('change', function () {
            settings.workflow = $(this).val();
            saveSettingsDebounced();
        });

        $('#cv_open_workflow_editor').on('click', onComfyOpenWorkflowEditorClick);
        $('#cv_new_workflow').on('click', onComfyNewWorkflowClick);
        $('#cv_rename_workflow').on('click', onComfyRenameWorkflowClick);
        $('#cv_delete_workflow').on('click', onComfyDeleteWorkflowClick);

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
            const loraHighSelect = $('#cv_lora_high');
            const loraLowSelect = $('#cv_lora_low');

            unetHighSelect.empty();
            unetLowSelect.empty();
            textEncSelect.empty();
            vaeSelect.empty();
            loraHighSelect.empty();
            loraLowSelect.empty();

            unetHighSelect.append($('<option value="">Auto-detect</option>'));
            unetLowSelect.append($('<option value="">Auto-detect</option>'));
            textEncSelect.append($('<option value="">Auto (UMT5 preferred)</option>'));
            vaeSelect.append($('<option value="">Default</option>'));
            loraHighSelect.append($('<option value="">None</option>'));
            loraLowSelect.append($('<option value="">None</option>'));

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
                    const option = $(`<option value="${loraName}">${loraName}</option>`);
                    loraHighSelect.append(option);
                    loraLowSelect.append(option.clone());
                });
            }

            unetHighSelect.val(settings.unetHigh || '');
            unetLowSelect.val(settings.unetLow || '');
            textEncSelect.val(settings.textEncoder || '');
            vaeSelect.val(settings.vae || '');
            loraHighSelect.val(settings.loraHigh || '');
            loraLowSelect.val(settings.loraLow || '');

            unetHighSelect.on('change', function () {
                settings.unetHigh = $(this).val();
                saveSettingsDebounced();
            });
            unetLowSelect.on('change', function () {
                settings.unetLow = $(this).val();
                saveSettingsDebounced();
            });
            textEncSelect.on('change', function () {
                settings.textEncoder = $(this).val();
                saveSettingsDebounced();
            });
            vaeSelect.on('change', function () {
                settings.vae = $(this).val();
                saveSettingsDebounced();
            });
            loraHighSelect.on('change', function () {
                settings.loraHigh = $(this).val();
                saveSettingsDebounced();
            });
            loraLowSelect.on('change', function () {
                settings.loraLow = $(this).val();
                saveSettingsDebounced();
            });
        }

        function setupSliderSync(sliderId, numberId, callback) {
            const slider = document.getElementById(sliderId);
            const number = document.getElementById(numberId);
            if (!slider || !number) return;
            slider.addEventListener('input', function () {
                number.value = this.value;
                if (callback) callback(Number(this.value));
            });
            number.addEventListener('input', function () {
                slider.value = this.value;
                if (callback) callback(Number(this.value));
            });
        }

        setupSliderSync('cv_steps', 'cv_steps_value', (val) => {
            settings.steps = val;
            updateSplitDisplay();
            saveSettingsDebounced();
        });
        setupSliderSync('cv_guidance', 'cv_guidance_value', (val) => {
            settings.guidance = val;
            saveSettingsDebounced();
        });
        setupSliderSync('cv_shift', 'cv_shift_value', (val) => {
            settings.shift = val;
            saveSettingsDebounced();
        });
        setupSliderSync('cv_split_point', 'cv_split_point_value', (val) => {
            settings.splitPoint = val;
            updateSplitDisplay();
            saveSettingsDebounced();
        });
        setupSliderSync('cv_cfg_high', 'cv_cfg_high_value', (val) => {
            settings.cfgHigh = val;
            saveSettingsDebounced();
        });
        setupSliderSync('cv_cfg_low', 'cv_cfg_low_value', (val) => {
            settings.cfgLow = val;
            saveSettingsDebounced();
        });
        setupSliderSync('cv_lora_weight', 'cv_lora_weight_value', (val) => {
            settings.loraWeight = val;
            saveSettingsDebounced();
        });

        function updateSplitDisplay() {
            const pct = settings.splitPoint ?? 50;
            const steps = settings.steps ?? 10;
            const high = Math.max(1, Math.round(steps * pct / 100));
            $('#cv_split_display').text(`${pct}% (${high} high / ${steps - high} low on ${steps} steps)`);
        }

        $('#cv_steps_value').val(settings.steps ?? 10);
        $('#cv_guidance_value').val(settings.guidance ?? 6.0);
        $('#cv_shift_value').val(settings.shift ?? 8.0);
        $('#cv_split_point_value').val(settings.splitPoint ?? 50);
        $('#cv_cfg_high_value').val(settings.cfgHigh ?? 2.0);
        $('#cv_cfg_low_value').val(settings.cfgLow ?? 1.0);
        $('#cv_lora_weight_value').val(settings.loraWeight ?? 0.9);
        updateSplitDisplay();

        $('#cv_seed').val(settings.seed ?? -1).on('input', function () {
            settings.seed = Number($(this).val());
            saveSettingsDebounced();
        });

        $('#cv_randomize_seed').on('click', () => {
            const newSeed = Math.floor(Math.random() * 2147483647);
            $('#cv_seed').val(newSeed);
            settings.seed = newSeed;
            saveSettingsDebounced();
        });

        $('#cv_send_image').prop('checked', settings.sendImage !== false).on('change', function () {
            settings.sendImage = $(this).is(':checked');
            saveSettingsDebounced();
        });

        $('#cv_use_sageattn').prop('checked', settings.useSageAttn !== false).on('change', function () {
            settings.useSageAttn = $(this).is(':checked');
            saveSettingsDebounced();
        });

        $('#cv_use_lora').prop('checked', settings.useLora === true).on('change', function () {
            settings.useLora = $(this).is(':checked');
            saveSettingsDebounced();
        });

        $('#cv_sage_attn_mode').val(settings.sageAttnMode || 'auto').on('change', function () {
            settings.sageAttnMode = $(this).val();
            saveSettingsDebounced();
        });

        $('#cv_sampler_high').val(settings.samplerHigh || 'euler_ancestral').on('change', function () {
            settings.samplerHigh = $(this).val();
            saveSettingsDebounced();
        });

        $('#cv_sampler_low').val(settings.samplerLow || 'euler_ancestral').on('change', function () {
            settings.samplerLow = $(this).val();
            saveSettingsDebounced();
        });

        $('#cv_scheduler').val(settings.scheduler || 'normal').on('change', function () {
            settings.scheduler = $(this).val();
            saveSettingsDebounced();
        });

        $('#cv_resolution').val(settings.resolution || '768,768').on('change', function () {
            const [w, h] = $(this).val().split(',').map(Number);
            settings.resolution = $(this).val();
            settings.width = w;
            settings.height = h;
            saveSettingsDebounced();
        });

        $('#cv_fps').val(settings.fps ?? 16).on('change', function () {
            settings.fps = Number($(this).val());
            saveSettingsDebounced();
        });

        $('#cv_duration').val(settings.duration ?? 5).on('change', function () {
            settings.duration = Number($(this).val());
            saveSettingsDebounced();
        });

        $('#cv_negative_prompt').val(settings.negativePrompt || '').on('input', function () {
            settings.negativePrompt = $(this).val();
            saveSettingsDebounced();
        });

        $('#cv_prompt_prefix').val(settings.promptPrefix || '').on('input', function () {
            settings.promptPrefix = $(this).val();
            saveSettingsDebounced();
        });

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
            } else {
                try {
                    prompt = await getMultimodalCaption(imageBase64, 'Describe this image concisely for video generation prompt:');
                } catch (e) {
                    console.warn('[ComfyUI-Video] Caption failed, using default:', e);
                }
            }

            const finalPrompt = settings.prompt || prompt || 'high quality, smooth motion, cinematic';
            const finalNegative = (settings.negativePrompt || negativePrompt || 'blurry, distorted, low quality, artifacts').trim();

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
