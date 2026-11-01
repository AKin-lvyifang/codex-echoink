/** The pure capability tests need only the same file identity as their host. */
declare const __echoinkFixtureTFile: typeof import("../mobile/host.mjs").FixtureTFile;
export const TFile = __echoinkFixtureTFile;
export { default as moment } from "moment";
export class TFolder { path = ""; name = ""; children: (InstanceType<typeof TFile> | TFolder)[] = []; }
