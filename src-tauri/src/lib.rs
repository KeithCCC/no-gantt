use std::fs;

use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn healthcheck() -> &'static str {
    "ok"
}

#[tauri::command]
async fn save_json_export(
    app: tauri::AppHandle,
    default_file_name: String,
    contents: String,
) -> Result<bool, String> {
    let Some(file_path) = app
        .dialog()
        .file()
        .set_file_name(&default_file_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(false);
    };

    let path = file_path
        .into_path()
        .map_err(|_| "Selected path is not a filesystem path.".to_string())?;

    fs::write(path, contents).map_err(|err| err.to_string())?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![healthcheck, save_json_export])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
