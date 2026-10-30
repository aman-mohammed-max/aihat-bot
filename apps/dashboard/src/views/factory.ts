import type { CreationSession, CreationStep, ModelCatalogEntry } from "../types.js";
import { escapeHtml, icon } from "../view-utils.js";

const steps: { id: CreationStep; label: string; helper: string }[] = [
  { id: "name", label: "Name your bot", helper: "Give your assistant a short, recognizable name." },
  { id: "description", label: "Write a description", helper: "A sentence or two about what this bot does." },
  { id: "purpose", label: "Set its purpose", helper: "Describe the tasks it should help with." },
  { id: "audience", label: "Choose its audience", helper: "Who will talk to this bot?" },
  { id: "personality", label: "Shape its personality", helper: "Write the system prompt: role, tone, and boundaries." },
  {
    id: "providerId",
    label: "Choose a model provider",
    helper: "Use a provider ID such as openai or your company slug.",
  },
  { id: "endpoint", label: "Set the API endpoint", helper: "The runtime allows only configured HTTPS origins." },
  { id: "model", label: "Pick a chat model", helper: "Fetch the models listed by this endpoint or enter a model ID." },
  {
    id: "credentialRef",
    label: "Connect model credentials",
    helper: "The API key is sent directly to the encrypted credential endpoint and never saved as a session answer.",
  },
  {
    id: "imageModel",
    label: "Choose an image model",
    helper: "Optional. Choose an image model exposed by this endpoint, or leave it blank to skip image generation.",
  },
  {
    id: "searchModel",
    label: "Choose a search model",
    helper: "Optional. Choose the model this endpoint uses for search, or leave it blank to skip search.",
  },
  {
    id: "skills",
    label: "List desired skills",
    helper: "Enter skill IDs you plan to install, one per line. You can review permissions later.",
  },
  {
    id: "mcpConnections",
    label: "Plan MCP connections",
    helper: "Enter connection names or URLs to revisit in the bot settings.",
  },
  {
    id: "integrations",
    label: "Plan integrations",
    helper: "List external services this assistant should connect to.",
  },
  {
    id: "memoryEnabled",
    label: "Choose memory behavior",
    helper:
      "Conversation history is stored by the runtime. Optional owner-written notes can add useful facts across chats.",
  },
  {
    id: "scheduledTasks",
    label: "Plan scheduled work",
    helper: "Add reminders or recurring work to configure after publishing.",
  },
  {
    id: "privacySettings",
    label: "Choose privacy settings",
    helper: "List any privacy rules that should shape the assistant.",
  },
  {
    id: "visibility",
    label: "Choose who can use it",
    helper: "Public access changes who can use this bot. Approval is required before saving a non-private choice.",
  },
  {
    id: "interfaces",
    label: "Choose its interfaces",
    helper: "Select at least one interface. Telegram is the first supported production channel.",
  },
];

export function factoryView(
  session?: CreationSession,
  error = "",
  models: readonly ModelCatalogEntry[] = [],
  modelsRole?: CreationStep,
  modelsBusy = false,
  pendingCredential = "",
): string {
  if (!session) {
    return `<section class="builder-intro"><div class="builder-spark">${icon("spark", 24)}</div><div class="builder-copy"><div class="eyebrow">BOTFATHER, REIMAGINED</div><h2>One clear idea is enough to get started.</h2><p>Follow a guided setup to shape the bot’s purpose, personality, model, privacy, and interfaces. You can pause and continue later.</p><ul><li>${icon("check", 15)} Secure model-key storage</li><li>${icon("check", 15)} Private by default</li><li>${icon("check", 15)} Publish only after review</li></ul><button class="button button-primary" data-action="start-factory">${icon("plus", 16)}<span>Start bot setup</span></button></div><div class="builder-orbit" aria-hidden="true"><div class="builder-orbit-core">${icon("botfather", 42)}</div><i></i><i></i><i></i></div></section>${error ? `<div class="alert alert-error" role="alert">${escapeHtml(error)}</div>` : ""}`;
  }

  const currentIndex = session.currentStep ? steps.findIndex((step) => step.id === session.currentStep) : steps.length;
  const progress =
    session.status === "published"
      ? 100
      : session.status === "draft" || session.status === "ready"
        ? 100
        : Math.max(4, Math.round((Math.max(0, currentIndex) / steps.length) * 100));
  const step = steps.find((item) => item.id === session.currentStep);
  const progressMarkup = steps
    .map(
      (item, index) =>
        `<span class="step-dot ${index < currentIndex ? "done" : index === currentIndex ? "current" : ""}" title="${escapeHtml(item.label)}">${index < currentIndex ? icon("check", 11) : index + 1}</span>`,
    )
    .join("");
  let body = "";
  if (session.status === "in_progress" && step) {
    body = `<div class="builder-step-copy"><span class="step-index">STEP ${String(currentIndex + 1).padStart(2, "0")} / ${String(steps.length).padStart(2, "0")}</span><h2>${escapeHtml(step.label)}</h2><p>${escapeHtml(step.helper)}</p></div>${error ? `<div class="alert alert-error" role="alert">${escapeHtml(error)}</div>` : ""}<form id="factory-answer-form" data-step="${step.id}" class="stack-form">${renderStepInput(step.id, session, models, modelsRole, modelsBusy, pendingCredential)}<div class="builder-form-footer"><button class="text-button" type="button" data-action="pause-factory">Pause and come back</button><button class="button button-primary" type="submit">${icon(step.id === "credentialRef" ? "shield" : "arrow", 16)}<span>${step.id === "credentialRef" ? "Encrypt and continue" : "Save and continue"}</span></button></div></form>`;
  } else if (session.status === "paused") {
    body = `<div class="builder-finish"><span class="finish-icon">${icon("pause", 23)}</span><div class="eyebrow">SAVED FOR LATER</div><h2>Your setup is paused.</h2><p>Continue from <b>${escapeHtml(step?.label ?? "the next step")}</b> whenever you’re ready.</p><button class="button button-primary" data-action="resume-factory">${icon("play", 16)}<span>Continue setup</span></button></div>`;
  } else if (session.status === "ready") {
    body = `<div class="builder-finish"><span class="finish-icon">${icon("check", 23)}</span><div class="eyebrow">CONFIGURATION READY</div><h2>Everything is in place.</h2><p>Save this as a private draft, review the details, then publish it when you are ready.</p><button class="button button-primary" data-action="save-factory-draft">${icon("check", 16)}<span>Save private draft</span></button></div>`;
  } else if (session.status === "draft") {
    body = `<div class="builder-finish"><span class="finish-icon">${icon("bots", 23)}</span><div class="eyebrow">PRIVATE DRAFT SAVED</div><h2>Your bot is ready for review.</h2><p>It remains private until you explicitly approve publishing. You can also finish this later from your bot list.</p><div class="builder-finish-actions"><button class="button button-secondary" data-route="bot/${escapeHtml(session.botId ?? "")}/overview">Review bot</button><button class="button button-primary" data-action="publish-factory">${icon("globe", 15)}<span>Approve & publish</span></button></div></div>`;
  } else {
    body = `<div class="builder-finish"><span class="finish-icon">${icon("check", 23)}</span><div class="eyebrow">PUBLISHED</div><h2>Your bot is live.</h2><p>Open its management page to connect Telegram and review its permissions.</p><button class="button button-primary" data-route="bot/${escapeHtml(session.botId ?? "")}/overview">Manage bot ${icon("arrow", 15)}</button></div>`;
  }

  return `<section class="builder-panel"><div class="builder-progress"><div class="builder-progress-top"><span>BOT SETUP</span><button class="icon-button" aria-label="Start a new bot" title="Start a new bot" data-action="new-factory">${icon("plus", 16)}</button></div><div class="progress-track"><span style="width:${progress}%"></span></div><div class="step-dots">${progressMarkup}</div></div><div class="builder-body">${body}</div><footer class="builder-footer"><span>${icon("shield", 14)} Credentials are encrypted · drafts are private</span><span>Session ${escapeHtml(session.id.slice(-8))}</span></footer></section>`;
}

function renderStepInput(
  step: CreationStep,
  session: CreationSession,
  models: readonly ModelCatalogEntry[],
  modelsRole: CreationStep | undefined,
  modelsBusy: boolean,
  pendingCredential: string,
): string {
  const value = session.answers[step];
  const textValue = typeof value === "string" ? value : "";
  const input = (label: string, placeholder: string, type = "text", defaults = "") =>
    `<label class="field"><span>${label}</span><input name="value" type="${type}" value="${escapeHtml(textValue || defaults)}" placeholder="${escapeHtml(placeholder)}" ${step === "credentialRef" ? 'autocomplete="new-password"' : ""} required /></label>`;
  const textarea = (label: string, placeholder: string, rows = 4) =>
    `<label class="field"><span>${label}</span><textarea name="value" rows="${rows}" placeholder="${escapeHtml(placeholder)}" required>${escapeHtml(textValue)}</textarea></label>`;
  switch (step) {
    case "name":
      return input("Name", "e.g. Atlas Support", "text");
    case "description":
      return textarea("Description", "A concise summary of what your bot can do.", 3);
    case "purpose":
      return textarea("Purpose", "Help my customers find answers and track open requests.", 3);
    case "audience":
      return textarea("Audience", "Who will use the assistant, and what do they need?", 3);
    case "personality":
      return textarea("System prompt", "You are a careful assistant for…", 6);
    case "providerId":
      return input("Provider ID", "openai", "text", "openai");
    case "endpoint":
      return input("HTTPS endpoint", "https://api.openai.com/v1", "url", "https://api.openai.com/v1");
    case "model":
    case "imageModel":
    case "searchModel": {
      const role = step === "model" ? "chat" : step === "imageModel" ? "image" : "search";
      const roleModels = modelsRole === step ? models : [];
      const keyInput =
        step === "model"
          ? `<label class="field"><span>Provider API key <small>temporary for model discovery</small></span><input name="discoveryCredential" type="password" value="${escapeHtml(pendingCredential)}" autocomplete="off" maxlength="65536" placeholder="Optional; used only to fetch models" /><small>The key is not saved here. You will confirm before it is encrypted on the next step.</small></label>`
          : "";
      const loadButton = `<button class="button button-secondary" type="button" data-action="load-factory-models" data-model-role="${role}" ${modelsBusy ? "disabled" : ""}>${icon("refresh", 15)}<span>${modelsBusy ? "Loading models…" : "Fetch models from endpoint"}</span></button>`;
      const modelLabel = step === "model" ? "Chat model" : step === "imageModel" ? "Image model" : "Search model";
      const modelInput = roleModels.length
        ? `<label class="field"><span>${modelLabel} from endpoint</span><select name="value" ${step === "model" ? "required" : ""}>${step === "model" ? `<option value="" disabled ${textValue ? "" : "selected"}>Choose a model</option>` : `<option value="" ${textValue ? "" : "selected"}>Skip this capability</option>`}${roleModels.map((model) => `<option value="${escapeHtml(model.id)}" ${textValue === model.id ? "selected" : ""}>${escapeHtml(model.name)} · ${escapeHtml(model.id)}</option>`).join("")}${textValue && !roleModels.some((model) => model.id === textValue) ? `<option value="${escapeHtml(textValue)}" selected>Current model · ${escapeHtml(textValue)}</option>` : ""}</select></label><label class="field"><span>Or enter a model ID</span><input name="customModel" value="${escapeHtml(textValue && !roleModels.some((model) => model.id === textValue) ? textValue : "")}" placeholder="${step === "model" ? "Enter an unlisted model ID" : "Optional; leave blank to skip"}" maxlength="128" autocomplete="off" /></label><small>${roleModels.length} models loaded from this endpoint. A custom model ID overrides the dropdown.</small>`
        : `<label class="field"><span>${modelLabel} ID</span><input name="value" value="${escapeHtml(textValue)}" placeholder="${step === "model" ? "e.g. gpt-4o-mini" : "Optional; leave blank to skip"}" ${step === "model" ? "required" : ""} maxlength="128" autocomplete="off" /></label>`;
      return `${keyInput}${loadButton}${modelInput}`;
    }
    case "credentialRef":
      return `<label class="field"><span>Provider API key</span><input name="value" type="password" value="${escapeHtml(pendingCredential)}" placeholder="Paste the key to encrypt it now" autocomplete="new-password" required /></label>`;
    case "skills":
    case "mcpConnections":
    case "integrations":
    case "scheduledTasks":
    case "privacySettings": {
      const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      const labels: Record<string, string> = {
        skills: "Planned skills",
        mcpConnections: "Server names or URLs",
        integrations: "External services",
        scheduledTasks: "Scheduled tasks",
        privacySettings: "Privacy rules",
      };
      return `<label class="field"><span>${labels[step]}</span><textarea name="value" rows="4" placeholder="One item per line">${escapeHtml(items.join("\n"))}</textarea><small>Optional. Leave blank if you want to decide in bot settings.</small></label>`;
    }
    case "memoryEnabled":
      return `<div class="choice-list"><label class="choice-card"><input type="radio" name="value" value="true" ${value === true ? "checked" : ""} required /><span><b>Enable persistent notes</b><small>Owner-written notes can be included across this bot’s chats.</small></span>${icon("chat", 17)}</label><label class="choice-card"><input type="radio" name="value" value="false" ${value === false ? "checked" : ""} required /><span><b>Keep memory off</b><small>You can change this later in the bot’s Memory tab.</small></span>${icon("shield", 17)}</label></div>`;
    case "visibility":
      return `<label class="field"><span>Visibility</span><select name="value"><option value="private" ${value === "private" || value === undefined ? "selected" : ""}>Private · owner only</option><option value="shared" ${value === "shared" ? "selected" : ""}>Shared · invited users</option><option value="invitation" ${value === "invitation" ? "selected" : ""}>Invitation only</option><option value="public" ${value === "public" ? "selected" : ""}>Public · anyone can discover</option></select></label><div class="alert alert-info compact-alert">Non-private visibility will ask you to confirm before the setting is saved.</div>`;
    case "interfaces": {
      const selected = Array.isArray(value) ? value : ["telegram"];
      return `<div class="choice-list">${(["telegram", "web_chat", "api"] as const).map((item) => `<label class="permission-check interface-choice"><input type="checkbox" name="value" value="${item}" ${selected.includes(item) ? "checked" : ""} /><span>${item === "web_chat" ? "Web chat" : item === "api" ? "Public API" : "Telegram"}</span></label>`).join("")}</div>`;
    }
  }
}
