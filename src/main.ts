import "./style.css";
import { VJApp } from "./app/VJApp";

const host = document.querySelector<HTMLDivElement>("#app");
if (!host) throw new Error("#app not found");

const app = new VJApp();
void app.init(host);

// HMRで旧インスタンスの入力監視やWebGLリソースが残らないよう破棄する
if (import.meta.hot) import.meta.hot.dispose(() => app.destroy());
