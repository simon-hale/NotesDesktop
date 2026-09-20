// Windows release 构建不要额外弹出控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    notes_desktop_lib::run()
}
