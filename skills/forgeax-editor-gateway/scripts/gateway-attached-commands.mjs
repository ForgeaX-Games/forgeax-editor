// Product-neutral structured commands for gateway.mjs.
// The caller supplies an eval function for the attached Editor realm; this module
// owns only CLI grammar and translation to the public EditGateway surface.

export const GATEWAY_ATTACHED_USAGE = [
  'list [--timeout <ms>]',
  'help <operation-kind> [--timeout <ms>]',
  'dispatch <operation-kind> [--input <json>] [--timeout <ms>]',
];

export function isGatewayAttachedCommand(argv) {
  return argv[0] === 'list' || argv[0] === 'help' || argv[0] === 'dispatch';
}

export function parseGatewayAttachedCommand(argv) {
  const args = [...argv];
  const command = args.shift();
  if (command === 'list') {
    const timeout = parseOptions(args, false).timeout;
    return { command, timeout };
  }
  if (command === 'help') {
    const operation = args.shift();
    if (!operation || operation.startsWith('--')) throw usageError('help requires an operation kind');
    const timeout = parseOptions(args, false).timeout;
    return { command, operation, timeout };
  }
  if (command !== 'dispatch') throw usageError(`unknown Gateway command '${command}'`);
  const operation = args.shift();
  if (!operation || operation.startsWith('--')) throw usageError('dispatch requires an operation kind');
  const parsed = parseOptions(args, true);
  return { command, operation, input: parsed.input, timeout: parsed.timeout };
}

export async function runGatewayAttachedCommand(argv, evaluate) {
  const parsed = parseGatewayAttachedCommand(argv);
  if (parsed.command === 'list') return evaluate('gateway.listOps()', parsed.timeout);
  if (parsed.command === 'help') {
    const operation = JSON.stringify(parsed.operation);
    return evaluate(
      `(()=>{const op=gateway.listOps().find((item)=>item.id===${operation});return op??{ok:false,error:{code:'OPERATION_NOT_REGISTERED',hint:'Run gateway.mjs list to discover operation kinds.'}}})()`,
      parsed.timeout,
    );
  }
  const operation = JSON.stringify(parsed.operation);
  const input = JSON.stringify(parsed.input);
  return evaluate(`gateway.dispatch({...${input},kind:${operation}},'ai')`, parsed.timeout);
}

function parseOptions(args, allowInput) {
  let input = {};
  let timeout;
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!value || value.startsWith('--')) throw usageError(`${flag} requires a value`);
    if (flag === '--timeout') {
      timeout = Number(value);
      if (!Number.isFinite(timeout)) throw usageError('--timeout must be a number');
    } else if (flag === '--input' && allowInput) {
      try {
        input = JSON.parse(value);
      } catch {
        throw usageError('--input must contain valid JSON');
      }
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw usageError('--input must contain a JSON object');
      }
    } else {
      throw usageError(`unknown option '${flag}'`);
    }
  }
  return { input, timeout };
}

function usageError(message) {
  const error = new Error(message);
  error.code = 'USAGE';
  return error;
}
