import "./style.css";
import { ControllerApp } from "./ControllerApp";

const host = document.querySelector<HTMLElement>("#controller-app");
if (!host) throw new Error("#controller-app not found");

const app = new ControllerApp(host);
void app.start();

// HMR時に旧PartySocketがreconnectし続けないよう明示破棄する
if (import.meta.hot) import.meta.hot.dispose(() => app.destroy());
