/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Augment ImportMeta for Vite HMR support
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface ImportMeta {
  readonly hot?: {
    accept: (cb?: (mod: any) => void) => void;
    dispose: (cb: (data: any) => void) => void;
    data: any;
  };
}
import { Part } from "@google/genai";

// google.type.LatLng
export interface LatLng {
  latitude: number;
  longitude: number;
}

// google.type.Date
export interface GoogleDate {
  year: number;
  month: number;
  day: number;
}

export interface GoogleMapsLinksType {
  directionsUri?: string;
  placeUri?: string;
  writeAReviewUri?: string;
  reviewsUri?: string;
  photosUri?: string;
}

export interface Place {
  id: string;
  place?: string; // resource name from API
  location?: LatLng;
  googleMapsLinks?: GoogleMapsLinksType;
  displayName?: { text: string };
  formattedAddress?: string; // Added for routing context
}

// Represents a waypoint for the Routes API
export interface RouteWaypoint {
  address?: string;
  place_id?: string;
  lat_lng?: LatLng;
  name?: string; // Human readable name for markers/display
}

// Represents the travel mode for the Routes API
export type TravelMode = 'DRIVE' | 'WALK' | 'TWO_WHEELER';

// Represents the data returned for a computed route
export interface RouteData {
  distanceMeters: number;
  duration: string; // e.g., "20924s"
  origin?: RouteWaypoint;
  destination?: RouteWaypoint;
  travelMode?: TravelMode;
  encodedPolyline?: string; // Encoded polyline string for rendering the route
}

export interface ToolExchange {
  toolName: string;
  request: any; // Raw JSON of the function call arguments
  response: any; // Raw JSON of the function response
  isFailure: boolean;
  placeIndex?: number;
}

// Represents a single message in the chat history, aligning with Gemini's Content object.
export interface ChatMessage {
  id: string;
  role: 'user' | 'model' | 'function'; // 'function' for tool responses
  parts: Part[]; // Array of Part objects from @google/genai (can contain text, functionCall, or functionResponse)
  timestamp: Date;
  error?: string; // Optional error message specifically for this message/step
  isFinal?: boolean;
  weatherData?: WeatherData; // Optional weather data associated with the message
  routeData?: RouteData; // Optional route data associated with the message
  places?: Place[]; // Optional places associated with the message
  toolExchanges?: ToolExchange[]; // Optional array of tool calls and responses made during this turn
  sourceURLs?: string[]; // Optional list of source URLs extracted from tool responses
  images?: string[]; // Optional base64 image data URLs the user attached to this message
}

export interface FailedToolResponse {
  status: number;
  rawBody: string;
}

// For managing API key availability state
export interface ApiKeysState {
  geminiApiKeySet: boolean;
  placesApiKeySet: boolean;
  googleMapsApiKey: boolean; // Track if the key is set
  googleMapsApiLoaded: boolean; // Track if the API has successfully loaded
  errorMessage?: string | null;
}

// Google Maps Platform Weather API types
export interface Temperature {
  degrees: number;
  unit: 'FAHRENHEIT' | 'CELSIUS';
}

export interface Wind {
  direction: {
    degrees: number;
    cardinal: string;
  };
  speed: {
    value: number;
    unit: 'MILES_PER_HOUR' | 'KILOMETERS_PER_HOUR';
  };
}

// Represents the location information returned by the weather tool after geocoding.
export interface ReturnedLocation {
  address?: string;
  placeId?: string; // Added to support placeId return from MCP tool
  name?: string; // Added to support human-readable name for map markers
  latLng?: LatLng;
}

export interface WeatherCondition {
  description: {
    text: string;
  };
  type: string;
  iconBaseUri?: string; // Updated based on API response structure
}

export interface WeatherData {
  temperature?: Temperature;
  feelsLikeTemperature?: Temperature;
  minTemperature?: Temperature;
  maxTemperature?: Temperature;
  weatherCondition?: WeatherCondition;
  wind?: Wind;
  relativeHumidity?: number;
  uvIndex?: number;
  returnedLocation?: ReturnedLocation;
  locationCoords?: LatLng; // Retained for map centering, populated from returnedLocation.latLng
}

// Represents the input location for the lookup_weather tool
export interface WeatherLocationInput {
  address?: string;
  placeId?: string;
  latLng?: LatLng;
}
