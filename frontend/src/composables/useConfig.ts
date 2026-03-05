import { reactive } from "vue";
import { type CrawlConfig, defaultConfig } from "../types/crawl";

const config = reactive<CrawlConfig>({ ...defaultConfig });

export function useConfig() {
  function reset() {
    Object.assign(config, defaultConfig);
  }

  return { config, reset };
}
