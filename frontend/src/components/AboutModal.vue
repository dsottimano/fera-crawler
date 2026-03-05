<script setup lang="ts">
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal about-modal">
      <h2>Fera SEO Crawler</h2>
      <p class="version">Version 0.1.0</p>
      <p class="desc">A cross-platform desktop SEO crawler built with Tauri, Vue, and Crawlee.</p>
      <p class="tech">Tauri v2 &bull; Vue 3 &bull; Playwright &bull; Crawlee</p>
      <button class="btn" @click="$emit('close')">Close</button>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  background: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  padding: 32px;
  min-width: 360px;
  color: #e0e0e0;
}

.about-modal {
  text-align: center;
}

.about-modal h2 {
  color: #e94560;
  margin: 0 0 8px;
}

.version {
  color: #a0a0a0;
  font-size: 0.85rem;
  margin: 0 0 16px;
}

.desc {
  margin: 0 0 8px;
  font-size: 0.9rem;
}

.tech {
  color: #a0a0a0;
  font-size: 0.8rem;
  margin: 0 0 24px;
}

.btn {
  padding: 8px 24px;
  background: #0f3460;
  color: #e0e0e0;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
}

.btn:hover {
  background: #1a4a80;
}
</style>
