"use client";

import { whatsappLink } from "@/lib/whatsapp";

/**
 * The WhatsApp affordance that sits beside a phone number.
 *
 * Deliberately quiet: a dimmed glyph that only takes on WhatsApp's green once
 * the row is hovered or the link is focused. A column of full-colour brand
 * marks would out-shout the phone numbers themselves, and the number is what
 * the agent is actually reading.
 *
 * Renders nothing when the number can't be resolved to an international one —
 * a dead link is worse than no link, since the agent would read WhatsApp's
 * error page as "this lead isn't on WhatsApp".
 */
export default function WhatsAppLink({
  phone,
  leadName,
}: {
  phone: string | null;
  leadName: string;
}) {
  const href = whatsappLink(phone);
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Chat on WhatsApp — ${leadName}`}
      aria-label={`Chat with ${leadName} on WhatsApp (opens in a new tab)`}
      // The row is a live editing surface, and the export table ticks rows.
      // Stop both here so opening a chat never doubles as a row action.
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-4 opacity-60 transition-[color,opacity] hover:text-st-green hover:opacity-100 focus-visible:text-st-green focus-visible:opacity-100 group-hover:opacity-100"
    >
      <WhatsAppIcon />
    </a>
  );
}

/** The WhatsApp glyph, drawn as one path so it inherits `currentColor`. */
function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8.02 1.6a6.35 6.35 0 0 0-5.4 9.7l-.94 3.44 3.53-.92a6.35 6.35 0 1 0 2.81-12.22Zm0 1.16a5.19 5.19 0 1 1-2.64 9.65l-.2-.12-2.1.55.56-2.04-.13-.21A5.19 5.19 0 0 1 8.02 2.76Zm-2.3 2.51c-.12 0-.31.05-.47.23-.16.18-.62.6-.62 1.47s.63 1.7.72 1.82c.09.12 1.23 1.96 3.04 2.67 1.5.59 1.81.47 2.14.44.33-.03 1.06-.43 1.21-.85.15-.42.15-.78.11-.85-.04-.07-.16-.12-.33-.2-.18-.09-1.06-.53-1.22-.59-.17-.06-.29-.09-.4.09-.13.17-.47.58-.57.7-.11.12-.21.13-.39.05-.18-.09-.76-.28-1.44-.9a5.4 5.4 0 0 1-1-1.24c-.1-.18-.01-.28.08-.36.08-.09.18-.22.27-.33.09-.11.12-.19.18-.31.06-.12.03-.23-.01-.32-.05-.09-.4-.97-.55-1.32-.14-.35-.29-.3-.4-.3l-.35-.01Z"
      />
    </svg>
  );
}
