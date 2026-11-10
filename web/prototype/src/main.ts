import { createApp } from "vue";
import App from "./App.vue";
import { applyPreset } from "./store";
import "./styles.css";

createApp(App).mount("#app");
if (location.hash) applyPreset(decodeURIComponent(location.hash.slice(1)));
