# No param() block on purpose: with one, PowerShell tries to bind piped input to
# a parameter and fails with "The input object cannot be bound to any parameters
# for the command", so `echo "..." | agent-bridge memory add --stdin` lost the
# text entirely and the CLI reported "No memory content". PowerShell prefers the
# .ps1 over the .cmd when both are on PATH, so this is the shim agents actually
# hit. Using the automatic $args plus $input forwards both the arguments and the
# pipeline.
$entry = "D:\TAILIEU\MyProject\AI_Tool\Optimize_token_and_memory_pool\packages\cli\dist\index.js"
if ($MyInvocation.ExpectingInput) {
  $input | & node $entry @args
} else {
  & node $entry @args
}
exit $LASTEXITCODE
