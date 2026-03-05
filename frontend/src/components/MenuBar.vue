<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{
  action: [menu: string, item: string];
}>();

const openMenu = ref<string | null>(null);

const menus: Record<string, string[]> = {
  File: ["New Crawl", "Open...", "Save", "-", "Export CSV", "Export Excel", "-", "Exit"],
  Configuration: ["Spider", "Robots.txt", "Speed", "User-Agent", "Custom Headers"],
  Mode: ["Spider", "List"],
  Export: ["Internal HTML", "All Links", "Response Codes", "Page Titles", "Redirects"],
  Reports: ["Crawl Overview", "Redirect Chains", "Duplicate Content", "Orphan Pages"],
  Help: ["Documentation", "About Fera"],
};

function toggle(name: string) {
  openMenu.value = openMenu.value === name ? null : name;
}

function close() {
  openMenu.value = null;
}

function handleItem(menu: string, item: string) {
  close();
  emit("action", menu, item);
}
</script>

<template>
  <nav class="menubar" @mouseleave="close">
    <div
      v-for="(items, name) in menus"
      :key="name"
      class="menu"
      @mouseenter="openMenu && (openMenu = name as string)"
    >
      <button
        class="menu-trigger"
        :class="{ active: openMenu === name }"
        @click="toggle(name as string)"
      >
        {{ name }}
      </button>
      <div v-if="openMenu === name" class="dropdown">
        <template v-for="(item, i) in items" :key="i">
          <hr v-if="item === '-'" class="separator" />
          <button v-else class="dropdown-item" @click="handleItem(name as string, item)">
            {{ item }}
          </button>
        </template>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.menubar {
  display: flex;
  background: #1a1a2e;
  border-bottom: 1px solid #0f3460;
  padding: 0 4px;
  user-select: none;
  flex-shrink: 0;
}

.menu {
  position: relative;
}

.menu-trigger {
  padding: 6px 12px;
  background: none;
  border: none;
  color: #c0c0c0;
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
}

.menu-trigger:hover,
.menu-trigger.active {
  background: #0f3460;
  color: #e0e0e0;
}

.dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 180px;
  background: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 0 0 4px 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  z-index: 100;
  padding: 4px 0;
}

.dropdown-item {
  display: block;
  width: 100%;
  padding: 6px 16px;
  background: none;
  border: none;
  color: #c0c0c0;
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.dropdown-item:hover {
  background: #0f3460;
  color: #e0e0e0;
}

.separator {
  border: none;
  border-top: 1px solid #0f3460;
  margin: 4px 8px;
}
</style>
