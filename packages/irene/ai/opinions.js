import { createOpinions, _internal } from "@defnotean/shared/opinions";
import { log } from "../utils/logger.js";
import { _getData, _markOpinionsDirty } from "./personality.js";

const opinions = /** @type {any} */ (createOpinions({
  getData: _getData,
  markOpinionsDirty: _markOpinionsDirty,
  log,
  safeDates: true,
}));

export const recordOpinion = opinions.recordOpinion;
export const findRelatedOpinions = opinions.findRelatedOpinions;
export const buildOpinionContext = opinions.buildOpinionContext;
export const listRecentOpinions = opinions.listRecentOpinions;
export { _internal };
