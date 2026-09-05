export {
  defineAction,
  compileSiteAction,
  type CallableSiteAction,
} from "../capabilities/define.js";
export {
  array,
  boolean,
  number,
  object,
  optional,
  productRef,
  string,
  type InferActionSchema,
  type InferActionType,
} from "../capabilities/schema.js";
export {
  click,
  css,
  extractList,
  extractText,
  fill,
  form,
  hrefField,
  inputRef,
  label,
  landmark,
  literalValue,
  navigate,
  role,
  select,
  testId,
  text,
  textField,
  urlField,
} from "../core/dsl.js";

export type { Condition, LocatorDefinition, LocatorScope, StepConditions } from "../core/types.js";
export { addStateImplementation } from "../capabilities/implementations.js";
