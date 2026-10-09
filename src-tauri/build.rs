fn main() {
    // Windows embeds the ICO at build time; rerun resource generation when
    // branding changes, even when tauri.conf.json is unchanged.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
