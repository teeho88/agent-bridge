using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class BridgeSandbox {
  [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities { public IntPtr Sid, Capabilities; public uint Count, Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo { public uint cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public uint Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string displayName,string description,IntPtr capabilities,uint count,out IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSidW(string value,out IntPtr sid);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupInfoEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr value,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr value,uint size,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint status);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SecurityAttributes security,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int id);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int info,IntPtr value,int size,out int returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref SecurityAttributes attributes,uint disposition,uint flags,IntPtr template);
  static void Check(bool ok,string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  static IntPtr Allocate(int size) { IntPtr p=Marshal.AllocHGlobal(size); for(int i=0;i<size;i++) Marshal.WriteByte(p,i,0); return p; }
  public static string Sid(string name) { IntPtr sid; int hr=DeriveAppContainerSidFromAppContainerName(name,out sid); Marshal.ThrowExceptionForHR(hr); try{return new SecurityIdentifier(sid).Value;}finally{FreeSid(sid);} }
  public static string Provision(string name) {
    IntPtr sid;int hr=CreateAppContainerProfile(name,name,"Bridge v2 isolated working copy",IntPtr.Zero,0,out sid);
    if(hr==unchecked((int)0x800700B7))return Sid(name);
    Marshal.ThrowExceptionForHR(hr);
    try{return new SecurityIdentifier(sid).Value;}finally{FreeSid(sid);}
  }
  static string Quote(string value) { if(value.IndexOf('\0')>=0)throw new ArgumentException("NUL argument"); var b=new StringBuilder("\""); int slash=0; foreach(char c in value) { if(c=='\\'){slash++;continue;} if(c=='\"') { b.Append('\\',slash*2+1);b.Append(c); } else { b.Append('\\',slash);b.Append(c); } slash=0; } b.Append('\\',slash*2);b.Append('\"');return b.ToString(); }
  public static string FileSystemPath(string path) {
    if(String.IsNullOrEmpty(path)||path.IndexOf('\0')>=0)throw new ArgumentException("Filesystem path required");
    if(path.StartsWith(@"\\?\",StringComparison.Ordinal))return path;
    string full=Path.GetFullPath(path);
    return full.StartsWith(@"\\",StringComparison.Ordinal)?@"\\?\UNC\"+full.Substring(2):@"\\?\"+full;
  }
  static string ProcessDirectory(string path) {
    string full=FileSystemPath(path);
    return full.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)?@"\\"+full.Substring(8):full.Substring(4);
  }
  public static int LaunchSupervisor(string helper,string request,string cwd) {
    string executable=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell\\v1.0\\powershell.exe");
    var startup=new StartupInfoEx();startup.Info.cb=(uint)Marshal.SizeOf(startup);
    var command=new StringBuilder(Quote(executable)+" -NoProfile -NonInteractive -WindowStyle Hidden -File "+Quote(helper)+" -RequestFile "+Quote(request));
    ProcessInfo info;
    Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,false,0x01000000|0x08000000|0x00000200,IntPtr.Zero,ProcessDirectory(cwd),ref startup,out info),"BreakawaySupervisor");
    CloseHandle(info.Thread);CloseHandle(info.Process);return (int)info.ProcessId;
  }
  public static string Run(string name,string executable,string[] args,string cwd,string stdout,string stderr,int parentId,int timeoutMs,bool internetClient,string nodeDirectory) {
    return RunCore(name,executable,args,cwd,stdout,stderr,parentId,timeoutMs,null,null,internetClient,nodeDirectory);
  }
  public static string RunInteractive(string name,string executable,string[] args,string cwd,string stdout,string stderr,int parentId,int timeoutMs,string stdinFile,string stopFile,bool internetClient,string nodeDirectory) {
    return RunCore(name,executable,args,cwd,stdout,stderr,parentId,timeoutMs,stdinFile,stopFile,internetClient,nodeDirectory);
  }
  public static string RunHost(string executable,string[] args,string cwd,string stdout,string stderr,int parentId,int timeoutMs,string stopFile,string nodeDirectory) {
    return RunCore(null,executable,args,cwd,stdout,stderr,parentId,timeoutMs,null,stopFile,true,nodeDirectory,true);
  }
  static string RunCore(string name,string executable,string[] args,string cwd,string stdout,string stderr,int parentId,int timeoutMs,string stdinFile,string stopFile,bool internetClient,string nodeDirectory,bool hostCoordinator=false) {
    IntPtr sid=IntPtr.Zero,list=IntPtr.Zero,security=IntPtr.Zero,job=IntPtr.Zero,jobValue=IntPtr.Zero,jobPointer=IntPtr.Zero,handlesPointer=IntPtr.Zero,environment=IntPtr.Zero,parent=IntPtr.Zero,token=IntPtr.Zero,tokenInfo=IntPtr.Zero;
    ProcessInfo process=new ProcessInfo(); IntPtr output=IntPtr.Zero,error=IntPtr.Zero,input=IntPtr.Zero;
    IntPtr inputWrite=IntPtr.Zero;var cancel=new ManualResetEvent(false);
    NamedPipeServerStream ingress=null;
    IntPtr networkSid=IntPtr.Zero,networkAttributes=IntPtr.Zero;
    bool initialized=false,created=false; uint exit=0; bool timedOut=false; int appContainer=0,totalProcesses=0;
    try {
      if(!hostCoordinator)Marshal.ThrowExceptionForHR(DeriveAppContainerSidFromAppContainerName(name,out sid));
      parent=OpenProcess(0x00100000,false,parentId); Check(parent!=IntPtr.Zero,"OpenParent");
      job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"CreateJob");
      jobValue=Allocate(IntPtr.Size==8?144:112); Marshal.WriteInt32(jobValue,16,0x2000); Check(SetInformationJobObject(job,9,jobValue,(uint)(IntPtr.Size==8?144:112)),"KillOnClose");
      var sa=new SecurityAttributes { Length=(uint)Marshal.SizeOf(typeof(SecurityAttributes)),Inherit=true };
      output=CreateFileW(FileSystemPath(stdout),0x40000000,1,ref sa,2,0x80,IntPtr.Zero); Check(output!=new IntPtr(-1),"OpenStdout");
      error=CreateFileW(FileSystemPath(stderr),0x40000000,1,ref sa,2,0x80,IntPtr.Zero); Check(error!=new IntPtr(-1),"OpenStderr");
      if(stdinFile==null){input=CreateFileW("NUL",0x80000000,3,ref sa,3,0x80,IntPtr.Zero);Check(input!=new IntPtr(-1),"OpenStdin");}
      else {Check(CreatePipe(out input,out inputWrite,ref sa,0),"CreateHostInputPipe");Check(SetHandleInformation(inputWrite,1,0),"PrivateInputWriter");}
      int attributeCount=hostCoordinator?2:3;
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,attributeCount,0,ref size); list=Allocate(size.ToInt32()); Check(InitializeProcThreadAttributeList(list,attributeCount,0,ref size),"InitializeAttributes"); initialized=true;
      var capabilities=new SecurityCapabilities{Sid=sid};
      if(internetClient){
        Check(ConvertStringSidToSidW("S-1-15-3-1",out networkSid),"InternetClientSid");
        var attribute=new SidAttributes{Sid=networkSid,Attributes=4};networkAttributes=Allocate(Marshal.SizeOf(attribute));Marshal.StructureToPtr(attribute,networkAttributes,false);
        capabilities.Capabilities=networkAttributes;capabilities.Count=1;
      }
      security=Allocate(Marshal.SizeOf(capabilities));Marshal.StructureToPtr(capabilities,security,false);
      if(!hostCoordinator)Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),security,new IntPtr(Marshal.SizeOf(capabilities)),IntPtr.Zero,IntPtr.Zero),"AppContainerAttribute");
      jobPointer=Allocate(IntPtr.Size);Marshal.WriteIntPtr(jobPointer,job);Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobPointer,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"JobListAttribute");
      handlesPointer=Allocate(IntPtr.Size*3);Marshal.WriteIntPtr(handlesPointer,0,input);Marshal.WriteIntPtr(handlesPointer,IntPtr.Size,output);Marshal.WriteIntPtr(handlesPointer,IntPtr.Size*2,error);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handlesPointer,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"HandleListAttribute");
      var startup=new StartupInfoEx();startup.Info.cb=(uint)Marshal.SizeOf(startup);startup.Info.flags=0x100;startup.Info.input=input;startup.Info.output=output;startup.Info.error=error;startup.Attributes=list;
      var cmd=new StringBuilder(Quote(executable));foreach(string arg in args)cmd.Append(" ").Append(Quote(arg));
      string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows); string home=Path.Combine(cwd,".bridge-home");string temp=Path.Combine(cwd,".bridge-tmp");
      if(String.IsNullOrEmpty(nodeDirectory)||!Path.IsPathRooted(nodeDirectory))throw new ArgumentException("Approved Node directory required");
      string cache=Path.Combine(home,"cache");
      string env="APPDATA="+home+"\0CODEX_HOME="+Path.Combine(home,"codex")+"\0COREPACK_HOME="+cache+"\0HOME="+home+"\0LOCALAPPDATA="+home+"\0NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main\0npm_config_cache="+cache+"\0PATH="+Path.GetDirectoryName(executable)+";"+nodeDirectory+";"+Path.Combine(windows,"System32")+";"+Path.Combine(windows,"System32","WindowsPowerShell","v1.0")+"\0PNPM_HOME="+cache+"\0SystemRoot="+windows+"\0TEMP="+temp+"\0TMP="+temp+"\0USERPROFILE="+home+"\0WINDIR="+windows+"\0XDG_CACHE_HOME="+cache+"\0XDG_CONFIG_HOME="+home+"\0\0";
      if(hostCoordinator)env="AGY_CLI_DISABLE_AUTO_UPDATE=true\0"+env;
      environment=Marshal.StringToHGlobalUni(env);
      Check(CreateProcessW(FileSystemPath(executable),cmd,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|0x08000000|4,environment,ProcessDirectory(cwd),ref startup,out process),"CreateAppContainerProcess");created=true;
      Check(OpenProcessToken(process.Process,8,out token),"OpenChildToken"); tokenInfo=Allocate(4);int returned;Check(GetTokenInformation(token,29,tokenInfo,4,out returned),"VerifyAppContainerToken");appContainer=Marshal.ReadInt32(tokenInfo);Check(appContainer==(hostCoordinator?0:1),"UnexpectedCoordinatorToken");
      if(stdinFile!=null){
        var pipe=inputWrite;
        var access=new PipeSecurity();var owner=WindowsIdentity.GetCurrent().User;
        access.SetAccessRuleProtection(true,false);access.SetOwner(owner);access.AddAccessRule(new PipeAccessRule(owner,PipeAccessRights.FullControl,AccessControlType.Allow));
        ingress=new NamedPipeServerStream(stdinFile,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,access);
        var source=ingress;
        var pump=new Thread(()=>{
          try{
            using(var destination=new FileStream(new SafeFileHandle(pipe,false),FileAccess.Write)){
              source.WaitForConnection();
              var buffer=new byte[4096];
              while(!cancel.WaitOne(0)){int count=source.Read(buffer,0,buffer.Length);if(count==0){cancel.Set();break;}destination.Write(buffer,0,count);destination.Flush();}
            }
          }catch(Exception failure){try{File.WriteAllText(FileSystemPath(stderr+".host"),failure.GetType().Name+": "+failure.Message);}catch{}cancel.Set();}
        });pump.IsBackground=true;pump.Start();
      }
      Check(ResumeThread(process.Thread)!=0xFFFFFFFF,"ResumeChild");
      var deadline=Stopwatch.StartNew();
      for(;;){
        uint wait=WaitForMultipleObjects(2,new IntPtr[]{process.Process,parent},false,50);
        if(wait==0){Check(GetExitCodeProcess(process.Process,out exit),"GetExitCode");break;}
        if(wait==1){exit=125;break;}
        if(wait!=258)throw new Win32Exception(Marshal.GetLastWin32Error(),"WaitForWriter");
        if(stopFile!=null&&File.Exists(FileSystemPath(stopFile))){exit=130;break;}
        if(cancel.WaitOne(0)){exit=126;break;}
        if(deadline.ElapsedMilliseconds>=timeoutMs){timedOut=true;exit=124;break;}
      }
      Check(TerminateJobObject(job,exit),"StopAllWriters");
      IntPtr accounting=Allocate(48);try { var clock=Stopwatch.StartNew(); for(;;){Check(QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero),"QueryStoppedWriters");totalProcesses=Marshal.ReadInt32(accounting,36);if(Marshal.ReadInt32(accounting,40)==0)break;if(clock.ElapsedMilliseconds>10000)throw new TimeoutException("Writers did not stop");Thread.Sleep(10);} } finally{Marshal.FreeHGlobal(accounting);}
      return "{\"exitStatus\":"+exit+",\"timedOut\":"+(timedOut?"true":"false")+",\"appContainer\":"+(appContainer==1?"true":"false")+",\"hostCoordinator\":"+(hostCoordinator?"true":"false")+",\"writersStopped\":true,\"activeProcesses\":0,\"totalProcesses\":"+totalProcesses+",\"internetClient\":"+(internetClient?"true":"false")+"}";
    } finally {
      cancel.Set();
      if(ingress!=null)ingress.Dispose();
      if(created&&job!=IntPtr.Zero)TerminateJobObject(job,125);
      foreach(IntPtr h in new IntPtr[]{process.Thread,process.Process,token,parent,input,inputWrite,output,error,job})if(h!=IntPtr.Zero&&h!=new IntPtr(-1))CloseHandle(h);
      if(initialized)DeleteProcThreadAttributeList(list);
      foreach(IntPtr p in new IntPtr[]{list,security,jobValue,jobPointer,handlesPointer,environment,tokenInfo})if(p!=IntPtr.Zero)Marshal.FreeHGlobal(p);
      if(sid!=IntPtr.Zero)FreeSid(sid);
      if(networkAttributes!=IntPtr.Zero)Marshal.FreeHGlobal(networkAttributes);
      if(networkSid!=IntPtr.Zero)LocalFree(networkSid);
    }
  }
}
