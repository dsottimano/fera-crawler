<script setup lang="ts">
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="logo-glow">FERA</div>
      <p class="version">v0.1.0</p>
      <p class="desc">Cross-platform desktop SEO crawler</p>
      <div class="tech-stack">
        <span class="badge">Tauri v2</span>
        <span class="badge">Vue 3</span>
        <span class="badge">Playwright</span>
      </div>
      <button class="btn" @click="$emit('close')">CLOSE</button>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 200; backdrop-filter: blur(6px); }
.modal { background: #141a2e; border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 36px 44px; min-width: 340px; color: #fff; box-shadow: 0 20px 60px rgba(0,0,0,0.5); text-align: center; }
.logo-glow { font-size: 30px; font-weight: 800; color: #569cd6; letter-spacing: 6px; text-shadow: 0 0 24px rgba(86,156,214,0.4); margin-bottom: 4px; }
.version { color: rgba(255,255,255,0.25); font-size: 11px; margin: 0 0 16px; letter-spacing: 1px; }
.desc { margin: 0 0 16px; font-size: 12px; color: rgba(255,255,255,0.6); }
.tech-stack { display: flex; gap: 6px; justify-content: center; margin-bottom: 22px; }
.badge { padding: 4px 12px; border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; font-size: 10px; color: rgba(255,255,255,0.45); letter-spacing: 0.5px; }
.btn { padding: 8px 26px; background: transparent; color: rgba(255,255,255,0.4); border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; cursor: pointer; font-size: 10px; font-weight: 700; letter-spacing: 1px; transition: all 0.15s; }
.btn:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
</style>
