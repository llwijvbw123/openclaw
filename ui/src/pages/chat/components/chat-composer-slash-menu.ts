import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons, type IconName } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  SLASH_COMMANDS,
  getSlashCommandCategoryLabel,
  getSlashCommandCompletions,
  getSlashCommandDescription,
  type SlashCommandArgChoice,
  type SlashCommandArgSpec,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { exportChatMarkdown } from "../export.ts";
import { commitComposerDraft, getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState, SlashArgStage } from "./chat-composer-types.ts";

export function resetSlashMenuState(state: ChatComposerState): void {
  state.slashMenuStage = null;
  state.slashArgInputFocusPending = false;
  state.slashMenuItems = [];
}

function hasVisibleSlashMenuState(state: ChatComposerState): boolean {
  return state.slashMenuOpen || state.slashMenuStage !== null || state.slashMenuItems.length > 0;
}

function closeSlashMenuIfNeeded(state: ChatComposerState, requestUpdate: () => void): void {
  if (!hasVisibleSlashMenuState(state)) {
    return;
  }
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

function requestSlashCommandRefresh(
  value: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  if (!props.onSlashIntent || state.slashCommandRefreshPending) {
    return;
  }
  const refresh = props.onSlashIntent();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  state.slashCommandRefreshPending = true;
  void Promise.resolve(refresh).finally(() => {
    state.slashCommandRefreshPending = false;
    // A catalog refresh started against the command list must not tear down an
    // argument stage the operator opened while it was in flight: staging clears
    // the draft, which this callback would otherwise read as "no longer slash".
    if (state.slashMenuStage) {
      return;
    }
    const nextValue = getCurrentValue?.() ?? props.getDraft?.() ?? value;
    if (!nextValue.startsWith("/")) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    updateSlashMenu(nextValue, requestUpdate, props, { skipSlashIntent: true });
  });
}

export function updateSlashMenu(
  value: string,
  requestUpdate: () => void,
  props: ChatComposerProps,
  opts: { skipSlashIntent?: boolean } = {},
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  const match = value.match(/^\/(\S*)$/);
  if (!match) {
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }
  if (!opts.skipSlashIntent) {
    requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
  }
  const items = getSlashCommandCompletions(match[1] ?? "", { showAll: true });
  state.slashMenuItems = items;
  state.slashMenuOpen = items.length > 0;
  state.slashMenuIndex = 0;
  state.slashMenuStage = null;
  state.slashArgInputFocusPending = false;
  requestUpdate();
}

export function getSlashStageArgSpec(stage: SlashArgStage): SlashCommandArgSpec | null {
  return stage.command.argSpecs?.[stage.index] ?? null;
}

/** Text of the command assembled so far, shown as the staged input's prefix. */
export function getSlashStagePrefix(stage: SlashArgStage): string {
  return [`/${stage.command.name}`, ...stage.values].join(" ");
}

function buildSlashArgStage(
  command: SlashCommandDef,
  values: string[],
  index: number,
): SlashArgStage | null {
  const spec = command.argSpecs?.[index];
  if (!spec) {
    return null;
  }
  return { command, values, index, choices: spec.choices ?? [], input: "" };
}

function openSlashArgStage(
  stage: SlashArgStage,
  props: ChatComposerProps,
  requestUpdate: () => void,
): void {
  const state = getChatComposerState(props.paneId);
  state.slashMenuStage = stage;
  state.slashMenuItems = [];
  state.slashMenuIndex = 0;
  state.slashMenuOpen = true;
  // Argument collection is owned by the staged input, so the assembled command
  // never sits half-written in the chat draft.
  commitComposerDraft(props, "");
  state.slashArgInputFocusPending = true;
  requestUpdate();
}

/** Drops staging entirely and hands the caret back to the message textarea. */
export function cancelSlashArgStage(props: ChatComposerProps, requestUpdate: () => void): void {
  const state = getChatComposerState(props.paneId);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
  requestUpdate();
}

/**
 * Runs the fully assembled command through the composer's normal send route.
 * Committing to the draft first is deliberate: a bare send is what records the
 * command in input history and clears the draft afterwards.
 */
function runStagedSlashCommand(
  command: SlashCommandDef,
  values: string[],
  props: ChatComposerProps,
  requestUpdate: () => void,
): void {
  const state = getChatComposerState(props.paneId);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  commitComposerDraft(props, [`/${command.name}`, ...values].join(" "));
  props.onSend();
  queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
  requestUpdate();
}

/**
 * Commits the current stage and advances to the next declared argument, running
 * the command only once no further argument remains. An empty value ends
 * collection early, which is how optional trailing arguments stay optional.
 */
export function commitSlashArgValue(
  value: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
): void {
  const state = getChatComposerState(props.paneId);
  const stage = state.slashMenuStage;
  if (!stage) {
    return;
  }
  const values = value ? [...stage.values, value] : stage.values;
  const next = value ? buildSlashArgStage(stage.command, values, stage.index + 1) : null;
  if (next) {
    openSlashArgStage(next, props, requestUpdate);
    return;
  }
  runStagedSlashCommand(stage.command, values, props, requestUpdate);
}

/** Escape steps back one argument, then out of staging into the composer. */
export function stepBackSlashArgStage(props: ChatComposerProps, requestUpdate: () => void): void {
  const state = getChatComposerState(props.paneId);
  const stage = state.slashMenuStage;
  const previous = stage
    ? buildSlashArgStage(stage.command, stage.values.slice(0, -1), stage.index - 1)
    : null;
  if (previous) {
    openSlashArgStage(previous, props, requestUpdate);
    return;
  }
  cancelSlashArgStage(props, requestUpdate);
}

export function selectSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  const state = getChatComposerState(props.paneId);
  const stage = buildSlashArgStage(cmd, [], 0);
  if (stage) {
    openSlashArgStage(stage, props, requestUpdate);
    return;
  }

  if (cmd.executeLocal && !cmd.args) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    commitComposerDraft(props, `/${cmd.name}`);
    props.onSend();
  } else {
    commitComposerDraft(props, `/${cmd.name} `);
    closeSlashMenuIfNeeded(state, requestUpdate);
  }
}

export function tabCompleteSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  const state = getChatComposerState(props.paneId);
  const stage = buildSlashArgStage(cmd, [], 0);
  if (stage) {
    openSlashArgStage(stage, props, requestUpdate);
    return;
  }
  commitComposerDraft(props, cmd.args ? `/${cmd.name} ` : `/${cmd.name}`);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

function slashOptionIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "item"
  );
}

export function paneDomId(paneId: string, suffix: string): string {
  return `chat-${encodeURIComponent(paneId)}-${suffix}`;
}

function getSlashCommandOptionId(paneId: string, cmd: SlashCommandDef): string {
  return paneDomId(paneId, `slash-option-command-${slashOptionIdSegment(cmd.name)}`);
}

function getSlashArgOptionId(paneId: string, commandName: string, arg: string): string {
  return paneDomId(
    paneId,
    `slash-option-arg-${slashOptionIdSegment(commandName)}-${slashOptionIdSegment(arg)}`,
  );
}

/** Choices left after the staged input's filter; empty on a free-value stage. */
export function getSlashStageChoices(stage: SlashArgStage): SlashCommandArgChoice[] {
  const filter = stage.input.trim().toLowerCase();
  if (!filter) {
    return stage.choices;
  }
  return stage.choices.filter(
    (choice) =>
      choice.value.toLowerCase().includes(filter) || choice.label.toLowerCase().includes(filter),
  );
}

/** True while the composer collects arguments for an already-chosen command. */
export function isSlashArgStageVisible(state: ChatComposerState): boolean {
  return state.slashMenuOpen && state.slashMenuStage !== null;
}

export function isSlashMenuVisible(state: ChatComposerState): boolean {
  if (!state.slashMenuOpen) {
    return false;
  }
  if (state.slashMenuStage) {
    return getSlashStageChoices(state.slashMenuStage).length > 0;
  }
  return state.slashMenuItems.length > 0;
}

export function getActiveSlashMenuOptionId(
  state: ChatComposerState,
  paneId: string,
): string | null {
  if (!isSlashMenuVisible(state)) {
    return null;
  }
  const stage = state.slashMenuStage;
  if (stage) {
    const choice = getSlashStageChoices(stage)[state.slashMenuIndex];
    return choice ? getSlashArgOptionId(paneId, stage.command.name, choice.value) : null;
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  return cmd ? getSlashCommandOptionId(paneId, cmd) : null;
}

export function getActiveSlashMenuOptionLabel(state: ChatComposerState): string {
  const stage = state.slashMenuStage;
  if (stage) {
    const spec = getSlashStageArgSpec(stage);
    const choice = isSlashMenuVisible(state)
      ? getSlashStageChoices(stage)[state.slashMenuIndex]
      : undefined;
    const step = `${getSlashStagePrefix(stage)} ${spec ? `[${spec.name}]` : ""}`.trim();
    return choice ? `${step} ${choice.label}` : step;
  }
  if (!isSlashMenuVisible(state)) {
    return "";
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  if (!cmd) {
    return "";
  }
  const command = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
  return `${command} ${getSlashCommandDescription(cmd)}`;
}

export function scrollActiveSlashMenuOptionIntoView(
  state: ChatComposerState,
  paneId: string,
): void {
  const activeId = getActiveSlashMenuOptionId(state, paneId);
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const scrollRegion = activeOption?.closest<HTMLElement>(".slash-menu__scroll");
    if (!activeOption || !scrollRegion) {
      return;
    }
    const menuBounds = scrollRegion.getBoundingClientRect();
    const optionBounds = activeOption.getBoundingClientRect();
    // scrollIntoView also moves the short-landscape composer and page. Keep
    // keyboard navigation owned by the menu so textarea focus stays stable.
    if (optionBounds.top < menuBounds.top) {
      scrollRegion.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      scrollRegion.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  });
}

function renderSlashIcon(name: string) {
  return icons[name as IconName] ?? icons.terminal;
}

export function exportMarkdown(props: Pick<ChatComposerProps, "messages" | "assistantName">): void {
  exportChatMarkdown(props.messages, props.assistantName);
}

/** Keyboard contract for the staged input; arrows are handled per phase. */
export function handleSlashArgInputKeyDown(
  event: KeyboardEvent,
  props: ChatComposerProps,
  requestUpdate: () => void,
): void {
  const state = getChatComposerState(props.paneId);
  const stage = state.slashMenuStage;
  if (!stage) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    stepBackSlashArgStage(props, requestUpdate);
    return;
  }
  const choices = getSlashStageChoices(stage);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (choices.length === 0) {
      return;
    }
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : choices.length - 1;
    state.slashMenuIndex = (state.slashMenuIndex + offset) % choices.length;
    requestUpdate();
    scrollActiveSlashMenuOptionIntoView(state, props.paneId);
    return;
  }
  if (event.key !== "Enter" && event.key !== "Tab") {
    return;
  }
  event.preventDefault();
  if (stage.choices.length > 0) {
    const choice = choices[state.slashMenuIndex];
    if (choice) {
      commitSlashArgValue(choice.value, props, requestUpdate);
    }
    return;
  }
  const value = stage.input.trim();
  // Tab only advances a stage that already has a value; an empty required stage
  // must not run a command that the operator has not finished describing.
  if (!value && (event.key === "Tab" || getSlashStageArgSpec(stage)?.required === true)) {
    return;
  }
  commitSlashArgValue(value, props, requestUpdate);
}

function getSlashArgPlaceholder(stage: SlashArgStage, spec: SlashCommandArgSpec): string {
  if (stage.choices.length > 0) {
    return t("chat.commands.argFilterPlaceholder", { arg: spec.name });
  }
  if (spec.dynamic) {
    return t("chat.commands.argDynamicUnavailable");
  }
  return spec.description || t("chat.commands.argValuePlaceholder", { arg: spec.name });
}

/**
 * The staged argument surface: one input per declared argument, prefixed by the
 * command assembled so far. It is the focus owner while a stage is open.
 */
export function renderSlashArgStage(
  requestUpdate: () => void,
  props: ChatComposerProps,
): TemplateResult | typeof nothing {
  const state = getChatComposerState(props.paneId);
  const stage = state.slashMenuStage;
  const spec = stage ? getSlashStageArgSpec(stage) : null;
  if (!stage || !spec) {
    return nothing;
  }
  state.slashArgInputRef ??= (element?: Element) => {
    state.slashArgInput = element instanceof HTMLInputElement ? element : null;
  };
  if (state.slashArgInputFocusPending) {
    state.slashArgInputFocusPending = false;
    queueMicrotask(() => state.slashArgInput?.focus({ preventScroll: true }));
  }
  const listboxId = paneDomId(props.paneId, "slash-menu-listbox");
  const hasChoices = getSlashStageChoices(stage).length > 0;
  return html`
    <div class="slash-arg-stage">
      <span class="slash-arg-stage__prefix">${getSlashStagePrefix(stage)}</span>
      <input
        ${ref(state.slashArgInputRef ?? undefined)}
        class="slash-arg-stage__input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        .value=${stage.input}
        placeholder=${getSlashArgPlaceholder(stage, spec)}
        aria-label=${t("chat.commands.argValueLabel", { arg: spec.name })}
        role=${stage.choices.length > 0 ? "combobox" : nothing}
        aria-autocomplete=${stage.choices.length > 0 ? "list" : nothing}
        aria-controls=${hasChoices ? listboxId : nothing}
        aria-expanded=${hasChoices ? "true" : nothing}
        aria-activedescendant=${getActiveSlashMenuOptionId(state, props.paneId) ?? nothing}
        aria-required=${spec.required ? "true" : nothing}
        @input=${(event: InputEvent) => {
          stage.input = (event.target as HTMLInputElement).value;
          state.slashMenuIndex = 0;
          requestUpdate();
        }}
        @keydown=${(event: KeyboardEvent) =>
          handleSlashArgInputKeyDown(event, props, requestUpdate)}
      />
      <span class="slash-arg-stage__hint">${spec.name}</span>
    </div>
  `;
}

export function renderSlashMenu(
  requestUpdate: () => void,
  props: ChatComposerProps,
  draft: string,
): TemplateResult | typeof nothing {
  const state = getChatComposerState(props.paneId);
  const listboxId = paneDomId(props.paneId, "slash-menu-listbox");
  if (!state.slashMenuOpen) {
    return nothing;
  }

  const stage = state.slashMenuStage;
  if (stage) {
    const choices = getSlashStageChoices(stage);
    if (choices.length === 0) {
      return nothing;
    }
    const spec = getSlashStageArgSpec(stage);
    return html`
      <div
        id=${listboxId}
        class="slash-menu"
        role="listbox"
        aria-label=${t("chat.commands.arguments")}
      >
        <div class="slash-menu__scroll">
          <div class="slash-menu-group">
            <div class="slash-menu-group__label">
              ${getSlashStagePrefix(stage)} ${spec?.description || spec?.name}
            </div>
            ${choices.map(
              (choice, i) => html`
                <div
                  id=${getSlashArgOptionId(props.paneId, stage.command.name, choice.value)}
                  class="slash-menu-item ${i === state.slashMenuIndex
                    ? "slash-menu-item--active"
                    : ""}"
                  role="option"
                  aria-selected=${i === state.slashMenuIndex}
                  @click=${() => commitSlashArgValue(choice.value, props, requestUpdate)}
                  @mouseenter=${() => {
                    state.slashMenuIndex = i;
                    requestUpdate();
                  }}
                >
                  <span class="slash-menu-leading">
                    <span class="slash-menu-icon"
                      >${stage.command.icon ? renderSlashIcon(stage.command.icon) : nothing}</span
                    >
                    <span class="slash-menu-name">${choice.label}</span>
                  </span>
                  <span class="slash-menu-trailing">
                    <span class="slash-menu-desc">
                      ${getSlashStagePrefix(stage)} ${choice.value}
                    </span>
                  </span>
                </div>
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }

  if (state.slashMenuItems.length === 0) {
    return nothing;
  }

  const groups: Array<[SlashCommandCategory, Array<{ cmd: SlashCommandDef; globalIdx: number }>]> =
    [];
  for (const [globalIdx, cmd] of state.slashMenuItems.entries()) {
    const category = cmd.category ?? "session";
    const group =
      draft === "/" ? groups.find(([groupCategory]) => groupCategory === category) : groups.at(-1);
    if (group?.[0] === category) {
      group[1].push({ cmd, globalIdx });
    } else {
      groups.push([category, [{ cmd, globalIdx }]]);
    }
  }

  const sections = groups.map(
    ([category, entries]) => html`
      <div class="slash-menu-group">
        <div class="slash-menu-group__label">${getSlashCommandCategoryLabel(category)}</div>
        ${entries.map(
          ({ cmd, globalIdx }) => html`
            <div
              id=${getSlashCommandOptionId(props.paneId, cmd)}
              class="slash-menu-item ${globalIdx === state.slashMenuIndex
                ? "slash-menu-item--active"
                : ""}"
              role="option"
              aria-selected=${globalIdx === state.slashMenuIndex}
              @click=${() => selectSlashCommand(cmd, props, requestUpdate)}
              @mouseenter=${() => {
                state.slashMenuIndex = globalIdx;
                requestUpdate();
              }}
            >
              <span class="slash-menu-leading">
                <span class="slash-menu-icon"
                  >${cmd.icon ? renderSlashIcon(cmd.icon) : nothing}</span
                >
                <span class="slash-menu-name">/${cmd.name}</span>
                ${cmd.args ? html`<span class="slash-menu-args">${cmd.args}</span>` : nothing}
              </span>
              <span class="slash-menu-trailing">
                <span class="slash-menu-desc">${getSlashCommandDescription(cmd)}</span>
                ${cmd.argSpecs?.[0]?.choices?.length
                  ? html`<span class="slash-menu-badge"
                      >${t("chat.commands.optionCount", {
                        count: String(cmd.argSpecs[0].choices.length),
                      })}</span
                    >`
                  : nothing}
              </span>
            </div>
          `,
        )}
      </div>
    `,
  );

  return html`
    <div id=${listboxId} class="slash-menu" role="listbox" aria-label=${t("chat.commands.menu")}>
      <div class="slash-menu__scroll">${sections}</div>
    </div>
  `;
}
