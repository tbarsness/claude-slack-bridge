#!/usr/bin/env bash
# voice-reply.sh — turn a short reply into a Slack-playable voice note.
#
# Used by the Slack assistants (jude/ivy/huahua/trey) to answer out loud.
# Prints the absolute path of the generated .m4a on stdout; the caller puts
# that path in an [ATTACH: ...] tag and the bridge uploads it to the thread.
#
#   voice-reply.sh "Books are reconciled. Two transactions still need receipts."
#   voice-reply.sh --voice Daniel "Running a bit behind."
#   echo "long text" | voice-reply.sh -
#
# Voice quality is deliberately the built-in macOS voice: free, offline, and
# instant. To upgrade, swap the `say` call for an ElevenLabs API request —
# Tim has a Creator subscription.

set -euo pipefail

VOICE="${VOICE_REPLY_VOICE:-Samantha}"
RATE="${VOICE_REPLY_RATE:-185}"
OUTDIR="${VOICE_REPLY_DIR:-${TMPDIR:-/tmp}/voice-replies}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --voice) VOICE="$2"; shift 2 ;;
    --rate)  RATE="$2";  shift 2 ;;
    --out)   OUTFILE="$2"; shift 2 ;;
    -)       TEXT="$(cat)"; shift ;;
    *)       TEXT="${TEXT:-}${TEXT:+ }$1"; shift ;;
  esac
done

if [[ -z "${TEXT:-}" ]]; then
  echo "voice-reply.sh: no text given" >&2
  exit 1
fi

mkdir -p "$OUTDIR"
OUTFILE="${OUTFILE:-$OUTDIR/reply-$(date +%Y%m%d-%H%M%S)-$$.m4a}"

# --data-format=aac keeps the file small and gives Slack an inline player.
say -v "$VOICE" -r "$RATE" --data-format=aac -o "$OUTFILE" "$TEXT"

echo "$OUTFILE"
