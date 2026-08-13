// Community invite card. Shadow DOM keeps its art-directed dark styling out of the
// global stylesheets and out of the startup CSS budget; the surrounding modal comes
// from the canonical dialog adapter so focus, Esc and the backdrop stay native.
import { css, html, svg } from "lit";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import { EXTERNAL_LINK_TARGET, buildExternalLinkRel } from "../lib/external-link.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { strokeIcon } from "./icons-tools.ts";
import "./modal-dialog.ts";

export const COMMUNITY_INVITE_URL = "https://discord.gg/clawd";
export const COMMUNITY_INVITE_SETTLED_EVENT = "community-invite-settled";

// Solid brand mark: the shared lucide set is stroked, so this one carries its own fill.
const discordMark = html`
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path
      d="M20.32 4.37a19.8 19.8 0 0 0-4.93-1.51 13.78 13.78 0 0 0-.64 1.29 18.27 18.27 0 0 0-5.5 0 12.64 12.64 0 0 0-.64-1.29 19.74 19.74 0 0 0-4.93 1.51C.53 9.05-.32 13.6.1 18.06a19.9 19.9 0 0 0 6.07 3.03c.46-.63.87-1.3 1.24-2a12.86 12.86 0 0 1-1.96-.93c.16-.12.32-.24.48-.37a14.2 14.2 0 0 0 12.14 0c.16.13.32.25.48.37-.63.37-1.28.68-1.96.93.36.7.78 1.37 1.24 2a19.84 19.84 0 0 0 6.07-3.03c.5-5.18-.84-9.68-3.58-13.69ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42 1.21 0 2.18 1.09 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.22 0 2.18 1.09 2.16 2.42 0 1.34-.94 2.42-2.16 2.42Z"
    />
  </svg>
`;

const arrowUpRight = strokeIcon(svg` <path d="M7 17 17 7" />
  <path d="M7 7h10v10" />`);

export class OpenClawCommunityInviteDialog extends OpenClawLitElement {
  static override styles = css`
    :host {
      display: contents;
    }

    openclaw-modal-dialog {
      --openclaw-modal-width: 380px;
    }

    .invite {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgb(255 255 255 / 12%);
      border-radius: 16px;
      /* The card is art-directed dark in both app themes: it frames a dark photo,
         and a light variant would wash the header seam out. */
      background: #10131c;
      color: #f3f5fb;
      box-shadow: 0 24px 60px rgb(0 0 0 / 45%);
    }

    .invite__header {
      position: relative;
      height: 148px;
      flex: none;
    }

    .invite__art {
      display: block;
      width: 100%;
      height: 100%;
      /* Calibrated to keep the lobster and the Discord pedestal centred in the
         short header crop; changing the height means re-checking this. */
      object-fit: cover;
      object-position: center 58%;
    }

    .invite__fade {
      position: absolute;
      inset: auto 0 -1px 0;
      height: 72px;
      background: linear-gradient(to bottom, rgb(16 19 28 / 0%), #10131c);
      pointer-events: none;
    }

    .invite__close {
      position: absolute;
      inset: 8px 8px auto auto;
      display: grid;
      width: 30px;
      height: 30px;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: rgb(0 0 0 / 35%);
      color: rgb(255 255 255 / 85%);
      cursor: pointer;
      transition:
        background 120ms ease,
        color 120ms ease;
    }

    .invite__close:hover {
      background: rgb(0 0 0 / 55%);
      color: #fff;
    }

    .invite__close:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 2px;
    }

    .invite__close svg {
      width: 16px;
      height: 16px;
    }

    .invite__body {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 4px 20px 20px;
    }

    .invite__eyebrow {
      margin: 0;
      color: #a5b4ff;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .invite__title {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.01em;
    }

    .invite__text {
      margin: 0;
      color: rgb(243 245 251 / 72%);
      font-size: 13.5px;
      line-height: 1.45;
    }

    .invite__cta {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 14px;
      padding: 11px 16px;
      border-radius: 10px;
      background: #fff;
      color: #10131c;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      transition:
        background 120ms ease,
        transform 120ms ease;
    }

    .invite__cta:hover {
      background: #e8eaf2;
    }

    .invite__cta:active {
      transform: translateY(1px);
    }

    .invite__cta:focus-visible {
      outline: 2px solid #a5b4ff;
      outline-offset: 2px;
    }

    .invite__cta svg {
      width: 18px;
      height: 18px;
      flex: none;
    }

    /* Same box as the leading brand mark so the label stays optically centred
       whether or not the trailing affordance is visible. */
    .invite__cta-trailing {
      display: grid;
      width: 18px;
      height: 18px;
      place-items: center;
      opacity: 0;
      transition: opacity 120ms ease;
    }

    .invite__cta-trailing svg {
      width: 14px;
      height: 14px;
    }

    .invite__cta:hover .invite__cta-trailing,
    .invite__cta:focus-visible .invite__cta-trailing {
      opacity: 0.55;
    }

    @media (prefers-reduced-motion: reduce) {
      .invite__close,
      .invite__cta,
      .invite__cta-trailing {
        transition: none;
      }
    }
  `;

  override render() {
    return html`
      <openclaw-modal-dialog
        .label=${t("communityInvite.dialogLabel")}
        @modal-cancel=${() => this.settle("dismissed")}
      >
        <div class="invite">
          <div class="invite__header">
            <img
              class="invite__art"
              src=${inferControlUiPublicAssetPath("community-art/discord-invite.webp")}
              alt=${t("communityInvite.artAlt")}
              width="1024"
              height="538"
            />
            <div class="invite__fade"></div>
            <button
              class="invite__close"
              type="button"
              autofocus
              aria-label=${t("common.close")}
              @click=${() => this.settle("dismissed")}
            >
              ${icons.x}
            </button>
          </div>
          <div class="invite__body">
            <p class="invite__eyebrow">${t("communityInvite.eyebrow")}</p>
            <h2 class="invite__title">${t("communityInvite.title")}</h2>
            <p class="invite__text">${t("communityInvite.body")}</p>
            <a
              class="invite__cta"
              href=${COMMUNITY_INVITE_URL}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
              @click=${() => this.settle("joined")}
            >
              ${discordMark}
              <span>${t("communityInvite.action")}</span>
              <span class="invite__cta-trailing" aria-hidden="true">${arrowUpRight}</span>
            </a>
          </div>
        </div>
      </openclaw-modal-dialog>
    `;
  }

  private settled = false;

  /** Both exits are terminal, so the owner records one outcome and drops the card. */
  private settle(outcome: "joined" | "dismissed") {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.dispatchEvent(
      new CustomEvent(COMMUNITY_INVITE_SETTLED_EVENT, {
        bubbles: true,
        composed: true,
        detail: { outcome },
      }),
    );
  }
}

if (!customElements.get("openclaw-community-invite-dialog")) {
  customElements.define("openclaw-community-invite-dialog", OpenClawCommunityInviteDialog);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-community-invite-dialog": OpenClawCommunityInviteDialog;
  }
}
