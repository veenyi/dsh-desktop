; DSH Desktop — NSIS 自定义逻辑（electron-builder nsis.include）
;
; 目标：升级 vs 全新安装识别。
;   - 已安装（同 appId 或历史 appId 的 DSH Desktop）：原位升级到原目录，跳过目录选择页
;   - 全新安装：正常走向导选择安装路径
;
; 原理：electron-builder 的 isUpdated 判定依据是当前 appId 的安装键
;   Software\{APP_GUID}\InstallLocation 是否存在。本文件在 customInit（.onInit 内、
;   页面显示前）扫描 Uninstall 注册表中 DisplayName = "DSH Desktop" 的旧安装，
;   把原目录登记到当前 appId 键 → isUpdated 命中 → 原位升级。
; 注意：只用经典 NSIS 语法（EnumRegKey 根键必须为字面量 HKxx，故按 hive 分块展开）。
; 仅在安装器编译时定义（卸载器编译阶段不展开 customInit，避免“未引用函数”警告即错误）。

!ifndef BUILD_UNINSTALLER

Var legacyInstallDir

; 计算 $3（完整路径）的所在目录 → $legacyInstallDir（算法同 electron-builder installUtil.getParent）
Function DSHGetParentDir
  StrCpy $6 0
  StrLen $7 $3
  dsh_parent_loop:
    IntOp $6 $6 + 1
    IntCmp $6 $7 dsh_parent_none dsh_parent_check dsh_parent_none
  dsh_parent_check:
    StrCpy $8 $3 1 -$6
    StrCmp $8 "\" dsh_parent_found dsh_parent_loop
  dsh_parent_found:
    StrCpy $legacyInstallDir $3 -$6
    Return
  dsh_parent_none:
    StrCpy $legacyInstallDir ""
FunctionEnd

; 扫描 HKCU 的 Uninstall 键，找到 DisplayName = "${PRODUCT_NAME}" 的安装 → $legacyInstallDir
Function DSHScanUninstallHKCU
  StrCpy $0 0
  dsh_scan_loop_hkcu:
    ClearErrors
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    IfErrors dsh_scan_done_hkcu
    StrCmp $1 "" dsh_scan_done_hkcu
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    StrCmp $2 "${PRODUCT_NAME}" 0 dsh_scan_next_hkcu
    ReadRegStr $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayIcon"
    StrCmp $3 "" dsh_scan_next_hkcu
    Call DSHGetParentDir
    Goto dsh_scan_done_hkcu
  dsh_scan_next_hkcu:
    IntOp $0 $0 + 1
    Goto dsh_scan_loop_hkcu
  dsh_scan_done_hkcu:
FunctionEnd

; 扫描 HKLM 的 Uninstall 键（per-machine 安装）
Function DSHScanUninstallHKLM
  StrCpy $0 0
  dsh_scan_loop_hklm:
    ClearErrors
    EnumRegKey $1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    IfErrors dsh_scan_done_hklm
    StrCmp $1 "" dsh_scan_done_hklm
    ReadRegStr $2 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    StrCmp $2 "${PRODUCT_NAME}" 0 dsh_scan_next_hklm
    ReadRegStr $3 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayIcon"
    StrCmp $3 "" dsh_scan_next_hklm
    Call DSHGetParentDir
    Goto dsh_scan_done_hklm
  dsh_scan_next_hklm:
    IntOp $0 $0 + 1
    Goto dsh_scan_loop_hklm
  dsh_scan_done_hklm:
FunctionEnd

!macro customInit
  ; 当前 appId 的安装键已存在 → 交给 electron-builder 原生 isUpdated 流程（正常升级路径）
  ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $R0 "" 0 dsh_custom_init_done
  ; 先扫 HKCU，再扫 HKLM
  StrCpy $legacyInstallDir ""
  Call DSHScanUninstallHKCU
  StrCmp $legacyInstallDir "" 0 dsh_adopt
  Call DSHScanUninstallHKLM
  dsh_adopt:
  StrCmp $legacyInstallDir "" dsh_custom_init_done
    ; 沿用旧安装目录并登记到当前 appId 键（两个 hive 都写，保证 isUpdated 判定命中）
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$legacyInstallDir"
    WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$legacyInstallDir"
    StrCpy $INSTDIR "$legacyInstallDir"
  dsh_custom_init_done:
!macroend

!endif ; BUILD_UNINSTALLER
