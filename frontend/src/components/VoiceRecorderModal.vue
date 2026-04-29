<script setup lang="ts">
import type { VoiceFlowState } from "../composables/useVoiceFlow";

defineProps<{
  show: boolean;
  state: VoiceFlowState;
  errorText?: string;
  userTranscript?: string;
  claudeText?: string;
}>();
</script>

<template>
  <Teleport to="body">
    <Transition name="voice-modal">
      <div v-if="show" class="voice-modal-backdrop">
        <div class="voice-modal" :class="`voice-modal--${state}`">
          <div class="voice-modal-pulse">
            <div v-if="state === 'recording'" class="pulse-ring"></div>
            <div v-if="state === 'recording'" class="pulse-ring pulse-ring--delay"></div>
            <div class="voice-modal-icon">
              <span v-if="state === 'recording'">&#x1F3A4;</span>
              <span v-else-if="state === 'speaking'">&#x1F50A;</span>
              <span v-else-if="state === 'error'">&#x26A0;</span>
              <span v-else>&#x23F3;</span>
            </div>
          </div>

          <div class="voice-modal-status">
            <template v-if="state === 'loading'">Loading model…</template>
            <template v-else-if="state === 'recording'">Listening…</template>
            <template v-else-if="state === 'transcribing'">Transcribing…</template>
            <template v-else-if="state === 'thinking'">Thinking…</template>
            <template v-else-if="state === 'speaking'">Speaking…</template>
            <template v-else-if="state === 'error'">{{ errorText || "Something went wrong" }}</template>
          </div>

          <div v-if="userTranscript && state !== 'recording' && state !== 'loading' && state !== 'error'"
               class="voice-bubble voice-bubble--user">
            <div class="voice-bubble-label">YOU</div>
            <div class="voice-bubble-text">{{ userTranscript }}</div>
          </div>

          <div v-if="claudeText && (state === 'speaking' || state === 'thinking')"
               class="voice-bubble voice-bubble--assistant">
            <div class="voice-bubble-label">FERA</div>
            <div class="voice-bubble-text">{{ claudeText }}</div>
          </div>

          <div class="voice-modal-hint">
            <template v-if="state === 'recording'">
              Press <kbd>/</kbd> to stop &middot; <kbd>Esc</kbd> to cancel
            </template>
            <template v-else-if="state === 'thinking' || state === 'transcribing' || state === 'loading'">
              <kbd>Esc</kbd> to dismiss
            </template>
            <template v-else-if="state === 'speaking'">
              Speaking… <kbd>Esc</kbd> to dismiss
            </template>
            <template v-else-if="state === 'error'">
              <kbd>Esc</kbd> to dismiss &middot; <kbd>/</kbd> to retry
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.voice-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.voice-modal {
  background: #1a1a1f;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 36px 48px 28px;
  min-width: 440px;
  max-width: 640px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
}

.voice-modal-pulse {
  position: relative;
  width: 96px;
  height: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.voice-modal-icon {
  position: relative;
  z-index: 2;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.85);
  transition: all 0.2s ease;
}

.voice-modal--recording .voice-modal-icon {
  background: rgba(255, 107, 107, 0.12);
  border-color: rgba(255, 107, 107, 0.5);
  color: #ff6b6b;
}

.voice-modal--speaking .voice-modal-icon {
  background: rgba(86, 156, 214, 0.12);
  border-color: rgba(86, 156, 214, 0.5);
  color: #569cd6;
  animation: speak-pulse 1s ease-in-out infinite;
}
@keyframes speak-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.06); }
}

.voice-modal--error .voice-modal-icon {
  color: #ff6b6b;
}

.pulse-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid rgba(255, 107, 107, 0.5);
  animation: pulse-out 1.6s ease-out infinite;
}
.pulse-ring--delay {
  animation-delay: 0.8s;
}
@keyframes pulse-out {
  0% { transform: scale(0.6); opacity: 0.9; }
  100% { transform: scale(1.4); opacity: 0; }
}

.voice-modal-status {
  font-size: 18px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.95);
  letter-spacing: 0.2px;
}

.voice-modal--error .voice-modal-status {
  color: #ff8b8b;
  font-size: 14px;
  max-width: 480px;
  text-align: center;
  font-weight: 400;
  line-height: 1.45;
}

.voice-bubble {
  width: 100%;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.voice-bubble--user {
  background: rgba(255, 255, 255, 0.04);
}

.voice-bubble--assistant {
  background: rgba(86, 156, 214, 0.06);
  border-color: rgba(86, 156, 214, 0.18);
}

.voice-bubble-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 1.2px;
  color: rgba(255, 255, 255, 0.4);
}

.voice-bubble--assistant .voice-bubble-label {
  color: rgba(86, 156, 214, 0.7);
}

.voice-bubble-text {
  font-size: 13px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.92);
  font-style: normal;
  max-height: 140px;
  overflow-y: auto;
}

.voice-modal-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  letter-spacing: 0.3px;
  margin-top: 4px;
}

.voice-modal-hint kbd {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  font-family: inherit;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
}

.voice-modal-enter-active,
.voice-modal-leave-active {
  transition: opacity 0.15s ease;
}
.voice-modal-enter-active .voice-modal,
.voice-modal-leave-active .voice-modal {
  transition: transform 0.18s ease, opacity 0.15s ease;
}
.voice-modal-enter-from,
.voice-modal-leave-to {
  opacity: 0;
}
.voice-modal-enter-from .voice-modal,
.voice-modal-leave-to .voice-modal {
  transform: scale(0.96);
  opacity: 0;
}
</style>
