use crate::{core::Core, settings::Versioned};
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
};
use serde_json::json;
use std::{convert::Infallible, sync::Arc, time::Duration};
pub async fn get_settings(State(core): State<Arc<Core>>) -> Json<serde_json::Value> {
    Json(json!({"current":core.settings.get(),"defaults":crate::settings::Settings::default()}))
}
pub async fn save_settings(
    State(core): State<Arc<Core>>,
    Json(input): Json<Versioned>,
) -> Response {
    let c = core.clone();
    match tokio::task::spawn_blocking(move || c.settings.save(input)).await {
        Ok(Ok(value)) => {
            let _ = core.wake.try_send(());
            core.history.record(
                "settings_changed",
                "nervo",
                json!({"revision":value.revision,"values":value.values}),
            );
            Json(json!({"current":value})).into_response()
        }
        Ok(Err(message)) => {
            let status = if message.starts_with("CONFLICT:") {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            (status, Json(json!({"error":message}))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":e.to_string()})),
        )
            .into_response(),
    }
}
pub async fn stream(State(core): State<Arc<Core>>) -> Response {
    let Ok(permit) = core.stream_slots.clone().try_acquire_owned() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Limite de 8 streams atingido",
        )
            .into_response();
    };
    let rx = core.updates.subscribe();
    let stream = futures_util::stream::unfold(
        (rx, core, 0u64, true, permit),
        |(mut rx, core, after, first, permit)| async move {
            if !first {
                tokio::select! {_=core.stream_stop.cancelled()=>return None,r=rx.changed()=>{if r.is_err(){return None;}}}
            }
            if core.stream_stop.is_cancelled() {
                return None;
            }
            rx.borrow_and_update();
            let events = core.history.read(after, 200);
            let next = events["next_cursor"].as_u64().unwrap_or(after);
            let frame = json!({"health":core.health(),"context":core.snapshot.read().unwrap().clone(),"events":events});
            Some((
                Ok::<_, Infallible>(Event::default().event("telemetry").data(frame.to_string())),
                (rx, core, next, false, permit),
            ))
        },
    );
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}
