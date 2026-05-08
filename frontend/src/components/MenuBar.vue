<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{
  action: [menu: string, item: string];
}>();

const openMenu = ref<string | null>(null);

const menus: Record<string, string[]> = {
  File: ["New Crawl", "-", "Saved Crawls...", "-", "Open...", "Save As...", "-", "Export CSV", "Export Excel", "Export Bundle (CSV + Images)...", "-", "Exit"],
  Configuration: ["Settings", "Scraper"],
  Export: ["Internal HTML", "All Links", "Response Codes", "Page Titles", "Redirects"],
  Reports: ["Crawl Overview", "Redirect Chains", "Duplicate Content", "Orphan Pages", "Internal PageRank"],
  Help: ["Documentation", "About Fera"],
};

function toggle(name: string) {
  openMenu.value = openMenu.value === name ? null : name;
}
function close() { openMenu.value = null; }
function handleItem(menu: string, item: string) { close(); emit("action", menu, item); }
</script>

<template>
  <nav class="menubar" @mouseleave="close">
    <div v-for="(items, name) in menus" :key="name" class="menu" @mouseenter="openMenu && (openMenu = name as string)">
      <button class="menu-trigger" :class="{ active: openMenu === name }" @click="toggle(name as string)">{{ name }}</button>
      <div v-if="openMenu === name" class="dropdown">
        <template v-for="(item, i) in items" :key="i">
          <hr v-if="item === '-'" class="separator" />
          <button v-else class="dropdown-item" @click="handleItem(name as string, item)">{{ item }}</button>
        </template>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.menubar {
  display: flex;
  background: #0c111d;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  padding: 0;
  user-select: none;
  flex-shrink: 0;
}
.menu { position: relative; }
.menu-trigger {
  padding: 5px 12px;
  background: none;
  border: none;
  color: rgba(255,255,255,0.45);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s;
}
.menu-trigger:hover, .menu-trigger.active {
  color: #ffffff;
  background: rgba(255,255,255,0.05);
}
.dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 190px;
  background: #161b2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  z-index: 100;
  padding: 4px;
  margin-top: 0;
}
.dropdown::before {
  content: "";
  position: absolute;
  top: -14px;
  left: -8px;
  right: -8px;
  height: 14px;
}
.dropdown-item {
  display: block;
  width: 100%;
  padding: 7px 14px;
  background: none;
  border: none;
  border-radius: 5px;
  color: rgba(255,255,255,0.7);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.1s;
}
.dropdown-item:hover {
  background: rgba(86,156,214,0.15);
  color: #ffffff;
}
.separator {
  border: none;
  border-top: 1px solid rgba(255,255,255,0.06);
  margin: 3px 8px;
}
</style>
