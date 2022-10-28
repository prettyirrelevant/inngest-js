import { queryKeys } from "../helpers/consts";
import { slugify } from "../helpers/strings";
import {
  EventPayload,
  FunctionConfig,
  FunctionOptions,
  FunctionTrigger,
  StepArgs,
} from "../types";
import {
  createStepTools,
  Op,
  OpId,
  OpStack,
  SubmitOpFn,
} from "./InngestStepTools";

/**
 * A stateless Inngest function, wrapping up function configuration and any
 * in-memory steps to run when triggered.
 *
 * This function can be "registered" to create a handler that Inngest can
 * trigger remotely.
 *
 * @public
 */
export class InngestFunction<Events extends Record<string, EventPayload>> {
  static stepId = "step";

  readonly #opts: FunctionOptions;
  readonly #trigger: FunctionTrigger<keyof Events>;
  readonly #fn: (...args: any[]) => any;

  /**
   * A stateless Inngest function, wrapping up function configuration and any
   * in-memory steps to run when triggered.
   *
   * This function can be "registered" to create a handler that Inngest can
   * trigger remotely.
   */
  constructor(
    /**
     * Options
     */
    opts: FunctionOptions,
    trigger: FunctionTrigger<keyof Events>,
    fn: (...args: any[]) => any
  ) {
    this.#opts = opts;
    this.#trigger = trigger;
    this.#fn = fn;
  }

  /**
   * The generated or given ID for this function.
   */
  public id(prefix?: string) {
    if (!this.#opts.id) {
      this.#opts.id = this.#generateId(prefix);
    }

    return this.#opts.id;
  }

  /**
   * The name of this function as it will appear in the Inngest Cloud UI.
   */
  public get name() {
    return this.#opts.name;
  }

  /**
   * Retrieve the Inngest config for this function.
   */
  private getConfig(
    /**
     * Must be provided a URL that will be used to access the function and step.
     * This function can't be expected to know how it will be accessed, so
     * relies on an outside method providing context.
     */
    baseUrl: URL,
    appPrefix?: string
  ): FunctionConfig {
    const fnId = this.id(appPrefix);

    const stepUrl = new URL(baseUrl.href);
    stepUrl.searchParams.set(queryKeys.FnId, fnId);
    stepUrl.searchParams.set(queryKeys.StepId, InngestFunction.stepId);

    return {
      id: fnId,
      name: this.name,
      triggers: [this.#trigger as FunctionTrigger],
      steps: {
        step: {
          id: InngestFunction.stepId,
          name: InngestFunction.stepId,
          runtime: {
            type: "http",
            url: stepUrl.href,
          },
        },
      },
    };
  }

  /**
   * Run a step in this function defined by `stepId` with `data`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  private async runFn(
    data: any,
    opStack: OpStack
  ): Promise<[isOp: true, op: Op | OpId] | [isOp: false, data: unknown]> {
    let nextOp: Op | OpId | undefined;

    const submitOp: SubmitOpFn = (op) => {
      nextOp = op;
    };

    // const tools = new InngestStepTools(opStack, submitOp);
    const mutableToolState: Parameters<typeof createStepTools>[2] = {
      pendingOp: undefined,
    };

    const tools = createStepTools(opStack, submitOp, mutableToolState);

    const fnArg = {
      ...(data as StepArgs<string, string, string>),
      tools,
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const ret = await this.#fn(fnArg);

    /**
     * This could be a step function that has triggered an asynchronous step
     * right at this moment.
     *
     * If this is the case, the above function will have now resolved and the
     * async step function might still be running.
     *
     * Let's check for this occurence by checking the toolset we created to see
     * if there is a pending op. If there is, wait for that, otherwise continue
     * straight to the end.
     */
    if (mutableToolState.pendingOp) {
      return [true, await mutableToolState.pendingOp];
    }

    /**
     * It could be that we have returned an op synchronously, in which case we
     * can use that here.
     */
    return nextOp ? [true, nextOp] : [false, ret];
  }

  /**
   * Generate an ID based on the function's name.
   */
  #generateId(prefix?: string) {
    return slugify([prefix || "", this.#opts.name].join("-"));
  }
}
