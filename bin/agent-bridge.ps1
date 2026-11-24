$entry = "D:\TAILIEU\MyProject\AI_Tool\Optimize_token_and_memory_pool\packages\cli\dist\index.js"
if ($MyInvocation.ExpectingInput) {
  $input | & node $entry @args
} else {
  & node $entry @args
}
exit $LASTEXITCODE
