import bwipjs from "bwip-js";

export const code128Buffer = (text: string, opts?: { width?: number; height?: number }) =>
  bwipjs.toBuffer({
    bcid: "code128",
    text,
    scale: 2,
    height: opts?.height ?? 12,
    width: opts?.width,
    includetext: true,
    textxalign: "center",
    textsize: 8,
    paddingwidth: 0,
    paddingheight: 0,
  });
