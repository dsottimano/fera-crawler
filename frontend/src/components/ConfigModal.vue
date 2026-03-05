<script setup lang="ts">
import { ref, computed } from "vue";
import { useConfig } from "../composables/useConfig";

const props = defineProps<{ section: string }>();
const emit = defineEmits<{ close: [] }>();

const { config } = useConfig();

const headerKey = ref("");
const headerValue = ref("");

const title = computed(() => {
  const titles: Record<string, string> = {
    spider: "Spider Settings",
    robots: "Robots.txt",
    speed: "Speed Settings",
    useragent: "User-Agent",
    headers: "Custom Headers",
  };
  return titles[props.section] ?? "Configuration";
});

function addHeader() {
  const k = headerKey.value.trim();
  const v = headerValue.value.trim();
  if (!k) return;
  config.customHeaders[k] = v;
  headerKey.value = "";
  headerValue.value = "";
}

function removeHeader(key: string) {
  delete config.customHeaders[key];
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="emit('close')">&times;</button>
      </div>

      <div class="modal-body">
        <!-- Spider Settings -->
        <template v-if="section === 'spider'">
          <label class="field">
            <span>Max Requests</span>
            <input v-model.number="config.maxRequests" type="number" min="1" max="100000" />
          </label>
          <label class="field">
            <span>Concurrency</span>
            <input v-model.number="config.concurrency" type="number" min="1" max="50" />
          </label>
          <label class="field">
            <span>Crawl Mode</span>
            <select v-model="config.mode">
              <option value="spider">Spider (follow links)</option>
              <option value="list">List (specific URLs)</option>
            </select>
          </label>
          <template v-if="config.mode === 'list'">
            <label class="field">
              <span>URLs (one per line)</span>
              <textarea
                :value="config.urls.join('\n')"
                @input="config.urls = ($event.target as HTMLTextAreaElement).value.split('\n').filter(u => u.trim())"
                rows="6"
                placeholder="https://example.com/page1&#10;https://example.com/page2"
              ></textarea>
            </label>
          </template>
        </template>

        <!-- Robots.txt -->
        <template v-if="section === 'robots'">
          <label class="field checkbox">
            <input v-model="config.respectRobots" type="checkbox" />
            <span>Respect robots.txt rules</span>
          </label>
        </template>

        <!-- Speed -->
        <template v-if="section === 'speed'">
          <label class="field">
            <span>Max Concurrent Requests</span>
            <input v-model.number="config.concurrency" type="number" min="1" max="50" />
          </label>
          <label class="field">
            <span>Delay Between Requests (ms)</span>
            <input v-model.number="config.delay" type="number" min="0" max="10000" step="100" />
          </label>
        </template>

        <!-- User-Agent -->
        <template v-if="section === 'useragent'">
          <label class="field">
            <span>User-Agent String</span>
            <input v-model="config.userAgent" type="text" placeholder="Leave empty for default Playwright UA" />
          </label>
        </template>

        <!-- Custom Headers -->
        <template v-if="section === 'headers'">
          <div class="header-list" v-if="Object.keys(config.customHeaders).length">
            <div v-for="(val, key) in config.customHeaders" :key="key" class="header-row">
              <span class="header-key">{{ key }}</span>
              <span class="header-val">{{ val }}</span>
              <button class="remove-btn" @click="removeHeader(key as string)">&times;</button>
            </div>
          </div>
          <div class="header-add">
            <input v-model="headerKey" type="text" placeholder="Header name" @keyup.enter="addHeader" />
            <input v-model="headerValue" type="text" placeholder="Value" @keyup.enter="addHeader" />
            <button class="add-btn" @click="addHeader">Add</button>
          </div>
        </template>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Done</button>
      </div>
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
  min-width: 420px;
  max-width: 560px;
  color: #e0e0e0;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #0f3460;
}

.modal-header h3 {
  margin: 0;
  font-size: 1rem;
}

.close-btn {
  background: none;
  border: none;
  color: #a0a0a0;
  font-size: 1.4rem;
  cursor: pointer;
  line-height: 1;
}

.close-btn:hover {
  color: #e0e0e0;
}

.modal-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.85rem;
}

.field span {
  color: #a0a0a0;
}

.field input[type="text"],
.field input[type="number"],
.field select,
.field textarea {
  padding: 8px 10px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 0.85rem;
  font-family: inherit;
}

.field textarea {
  resize: vertical;
}

.field.checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.field.checkbox input {
  width: 16px;
  height: 16px;
}

.header-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.header-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #16213e;
  border-radius: 4px;
  font-size: 0.8rem;
}

.header-key {
  font-weight: 600;
  min-width: 100px;
}

.header-val {
  flex: 1;
  color: #a0a0a0;
}

.remove-btn {
  background: none;
  border: none;
  color: #e94560;
  font-size: 1.1rem;
  cursor: pointer;
}

.header-add {
  display: flex;
  gap: 8px;
}

.header-add input {
  flex: 1;
  padding: 8px 10px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 0.85rem;
}

.add-btn {
  padding: 8px 16px;
  background: #0f3460;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.85rem;
}

.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid #0f3460;
  text-align: right;
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
